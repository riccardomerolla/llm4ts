package com.demobank.legacy.web;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.List;

import javax.servlet.RequestDispatcher;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import com.demobank.legacy.dto.BenfDTO;
import com.demobank.legacy.dto.TrfDTO;
import com.demobank.legacy.esb.EsbBenfListService;
import com.demobank.legacy.esb.EsbException;
import com.demobank.legacy.esb.EsbTrfExecService;
import com.demobank.legacy.esb.EsbTrfValidateService;

/**
 * HERO 3 controller. Mapped on /transfer. Drives the 3-step wizard and
 * keeps the in-flight TransferDraft in HttpSession ("trfDraft") -- the
 * hardest conversion case in the fixture.
 *
 * GET  /transfer          -> start (or resume) at step 1; loads the
 *                            beneficiary combo via ESB_BENF_LIST
 * POST step=1             -> parse + validate entry, store draft in
 *                            session, ESB_TRF_VAL, forward to step 2
 * POST step=3             -> ESB_TRF_EXEC with the session draft, clear
 *                            the draft, forward to confirmation
 *
 * (There is no POST step=2: the review page holds no fields, it re-posts
 * only the confirmation. Numbering kept for the ops runbook.)
 *
 * ESB dependencies: ESB_BENF_LIST, ESB_TRF_VAL, ESB_TRF_EXEC.
 */
public class TransferServlet extends HttpServlet {

    private static final long serialVersionUID = 1L;

    private final EsbBenfListService benfListService = new EsbBenfListService();
    private final EsbTrfValidateService validateService = new EsbTrfValidateService();
    private final EsbTrfExecService execService = new EsbTrfExecService();

    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {
        // Entry point and "Back" target: always renders step 1, keeping any
        // draft already in session so the fields come back pre-filled.
        renderStep1(request, response, null);
    }

    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        String step = request.getParameter("step");
        if ("1".equals(step)) {
            handleStep1(request, response);
        } else if ("3".equals(step)) {
            handleStep3(request, response);
        } else {
            // Unknown step: restart the wizard (legacy catch-all).
            response.sendRedirect("transfer");
        }
    }

    /** Parse the entry form, ESB-validate, park the draft in session. */
    private void handleStep1(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        HttpSession session = request.getSession(true);
        String custId = custId(session);

        String benfId = trim(request.getParameter("benfId"));
        String amtRaw = trim(request.getParameter("trfAmt"));

        if (isEmpty(benfId) || isEmpty(amtRaw)) {
            renderStep1(request, response, "Beneficiary and amount are required.");
            return;
        }

        BigDecimal amt;
        try {
            // Server accepts the dot only; the client tolerates a comma and
            // rewrites it -- known mismatch DB-3302, users with JS disabled
            // hit this branch.
            amt = new BigDecimal(amtRaw);
        } catch (NumberFormatException e) {
            renderStep1(request, response, "Amount format not valid (use 1234.56).");
            return;
        }
        if (amt.compareTo(BigDecimal.ZERO) <= 0 || amt.scale() > 2) {
            renderStep1(request, response, "Amount must be positive with max 2 decimals.");
            return;
        }

        TransferDraft draft = new TransferDraft();
        draft.setBenfId(benfId);
        draft.setTrfAmt(amt);
        draft.setTrfCcy("EUR"); // only EUR online, combo is decorative
        draft.setTrfDesc(sanitizeDesc(request.getParameter("trfDesc")));
        draft.setValDt(trim(request.getParameter("valDt")));

        try {
            BenfDTO benf = benfListService.getBeneficiary(custId, benfId);
            if (benf == null) {
                renderStep1(request, response, "Selected beneficiary no longer exists.");
                return;
            }
            draft.setBenfNm(benf.getBenfNm());
            draft.setBenfIban(benf.getBenfIban());

            String rc = validateService.validate(custId, draft);
            if (!"0000".equals(rc)) {
                renderStep1(request, response, validationMessage(rc));
                return;
            }
            // Real portal: VAL-TOKEN comes back inside ESB_TRF_VAL response;
            // wrapper keeps it on the draft via this setter since rel. 2.5.
            if (draft.getValToken() == null) {
                draft.setValToken("VT-" + session.getId());
            }
        } catch (EsbException e) {
            renderStep1(request, response,
                    "Service temporarily unavailable, please retry (rc " + e.getEsbRc() + ").");
            return;
        }

        // Park the draft for step 2/3. THE session attribute of this app.
        session.setAttribute("trfDraft", draft);

        request.setAttribute("draft", draft);
        forward(request, response, "/transferStep2.jsp");
    }

    /** Execute against the host using the session draft, then clear it. */
    private void handleStep3(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        HttpSession session = request.getSession(true);
        TransferDraft draft = (TransferDraft) session.getAttribute("trfDraft");
        if (draft == null) {
            // Session expired between review and confirm: restart.
            response.sendRedirect("transfer");
            return;
        }

        TrfDTO res;
        try {
            res = execService.execute(custId(session), draft);
        } catch (EsbException e) {
            res = new TrfDTO();
            res.setStatus("KO");
            res.setHostRc(e.getEsbRc());
            res.setHostMsg("HOST UNREACHABLE - TRANSFER NOT EXECUTED");
        }

        // Draft must not survive execution (double-submit guard is host-side
        // via VAL-TOKEN, but keep the session clean anyway).
        session.removeAttribute("trfDraft");

        request.setAttribute("trfRes", res);
        forward(request, response, "/transferConfirm.jsp");
    }

    private void renderStep1(HttpServletRequest request, HttpServletResponse response,
            String stepErr) throws ServletException, IOException {

        HttpSession session = request.getSession(true);
        try {
            List combo = benfListService.listBeneficiaries(custId(session));
            request.setAttribute("benfCombo", combo);
        } catch (EsbException e) {
            request.setAttribute("benfCombo", new java.util.ArrayList());
        }
        // Pre-fill from any draft still in session (Back from review).
        TransferDraft draft = (TransferDraft) session.getAttribute("trfDraft");
        if (draft != null) {
            request.setAttribute("draft", draft);
        }
        if (stepErr != null) {
            request.setAttribute("stepErr", stepErr);
        }
        forward(request, response, "/transferStep1.jsp");
    }

    /** Host charset is restrictive; strip what SEPA remittance rejects. */
    private String sanitizeDesc(String desc) {
        if (desc == null) return null;
        String cleaned = desc.replaceAll("[^A-Za-z0-9 .,/()-]", " ").trim();
        return cleaned.length() > 140 ? cleaned.substring(0, 140) : cleaned;
    }

    private String validationMessage(String rc) {
        if ("0201".equals(rc)) return "Insufficient available balance.";
        if ("0205".equals(rc)) return "Daily online transfer limit exceeded (EUR 5,000.00).";
        if ("0207".equals(rc)) return "Transfer refused by compliance screening.";
        return "Transfer refused by the bank host (code " + rc + ").";
    }

    private void forward(HttpServletRequest request, HttpServletResponse response,
            String jsp) throws ServletException, IOException {
        RequestDispatcher rd = request.getRequestDispatcher(jsp);
        rd.forward(request, response);
    }

    private String custId(HttpSession session) {
        String custId = (String) session.getAttribute("custId");
        if (custId == null) {
            custId = "CUST0042";
            session.setAttribute("custId", custId);
        }
        return custId;
    }

    private String trim(String s) {
        return s == null ? null : s.trim();
    }

    private boolean isEmpty(String s) {
        return s == null || s.trim().length() == 0;
    }
}
