package com.demobank.legacy.web;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import javax.servlet.RequestDispatcher;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import com.demobank.legacy.dto.BenfDTO;
import com.demobank.legacy.esb.EsbBenfListService;
import com.demobank.legacy.esb.EsbBenfMaintService;
import com.demobank.legacy.esb.EsbException;

/**
 * HERO 2 controller. Mapped on /beneficiary.
 *
 * GET  ?action=list (default) -> beneficiaryList.jsp ("benfList")
 * GET  ?action=new            -> beneficiaryEdit.jsp (empty "benf")
 * GET  ?action=edit&benfId=.. -> beneficiaryEdit.jsp (loaded "benf")
 * GET  ?action=delete&benfId= -> delete then redirect to list  [sic: GET
 *                                with side effect, kept legacy-faithful]
 * POST                        -> server-side validation + ESB_BENF_MAINT
 *
 * Server-side validation deliberately overlaps but does not match the
 * client rules in beneficiaryEdit.jsp / validate.js (see DB-2988, DB-3302):
 *   - name required, max 60 chars (client allows 70)
 *   - IBAN required, shape check, AND country must be IT/DE/FR (client
 *     checks shape only)
 *   - bank name required when ccy != EUR (client treats it as optional)
 *
 * ESB dependencies: ESB_BENF_LIST, ESB_BENF_MAINT.
 */
public class BeneficiaryServlet extends HttpServlet {

    private static final long serialVersionUID = 1L;

    private final EsbBenfListService listService = new EsbBenfListService();
    private final EsbBenfMaintService maintService = new EsbBenfMaintService();

    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        String custId = custId(request);
        String action = request.getParameter("action");
        if (action == null) action = "list";

        try {
            if ("new".equals(action)) {
                BenfDTO empty = new BenfDTO();
                empty.setCcyCd("EUR");
                request.setAttribute("benf", empty);
                forward(request, response, "/beneficiaryEdit.jsp");
            } else if ("edit".equals(action)) {
                BenfDTO benf = listService.getBeneficiary(custId,
                        request.getParameter("benfId"));
                if (benf == null) {
                    response.sendRedirect("beneficiary");
                    return;
                }
                request.setAttribute("benf", benf);
                forward(request, response, "/beneficiaryEdit.jsp");
            } else if ("delete".equals(action)) {
                maintService.delete(custId, request.getParameter("benfId"));
                request.getSession().setAttribute("flashOnce", "Beneficiary deleted.");
                response.sendRedirect("beneficiary");
            } else {
                renderList(request, response, custId);
            }
        } catch (EsbException e) {
            System.out.println("BENF esb failure rc=" + e.getEsbRc());
            request.setAttribute("benfList", new ArrayList());
            forward(request, response, "/beneficiaryList.jsp");
        }
    }

    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        String custId = custId(request);

        BenfDTO benf = new BenfDTO();
        benf.setBenfId(trim(request.getParameter("benfId")));
        benf.setBenfNm(trim(request.getParameter("benfNm")));
        benf.setBenfIban(trim(request.getParameter("benfIban")));
        benf.setBankNm(trim(request.getParameter("bankNm")));
        benf.setCcyCd(trim(request.getParameter("ccyCd")));

        List errs = validate(benf);
        if (!errs.isEmpty()) {
            request.setAttribute("srvErrs", errs);
            request.setAttribute("benf", benf);
            forward(request, response, "/beneficiaryEdit.jsp");
            return;
        }

        try {
            String rc = maintService.save(custId, benf);
            if (!"0000".equals(rc)) {
                errs.add(hostMessage(rc));
                request.setAttribute("srvErrs", errs);
                request.setAttribute("benf", benf);
                forward(request, response, "/beneficiaryEdit.jsp");
                return;
            }
        } catch (EsbException e) {
            errs.add("Service temporarily unavailable, please retry (rc "
                    + e.getEsbRc() + ").");
            request.setAttribute("srvErrs", errs);
            request.setAttribute("benf", benf);
            forward(request, response, "/beneficiaryEdit.jsp");
            return;
        }

        request.getSession().setAttribute("flashOnce", "Beneficiary saved.");
        response.sendRedirect("beneficiary");
    }

    /** Server-side rules. Compare with the jQuery rules in the JSP. */
    private List validate(BenfDTO benf) {
        List errs = new ArrayList();
        if (isEmpty(benf.getBenfNm())) {
            errs.add("Beneficiary name is required.");
        } else if (benf.getBenfNm().length() > 60) {
            // client-side allows 70 -- host field is CHAR(60), see DB-2988
            errs.add("Beneficiary name must not exceed 60 characters.");
        }
        String iban = benf.getBenfIban() == null
                ? "" : benf.getBenfIban().replaceAll(" ", "").toUpperCase();
        if (iban.length() == 0) {
            errs.add("IBAN is required.");
        } else if (!iban.matches("[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}")) {
            errs.add("IBAN format is not valid.");
        } else {
            String country = iban.substring(0, 2);
            // client checks shape only; SEPA scheme subset enforced here
            if (!"IT".equals(country) && !"DE".equals(country) && !"FR".equals(country)) {
                errs.add("Only IT, DE and FR IBANs are accepted online.");
            }
        }
        if (!"EUR".equals(benf.getCcyCd()) && isEmpty(benf.getBankNm())) {
            // client treats bank name as always optional
            errs.add("Bank name is required for non-EUR beneficiaries.");
        }
        return errs;
    }

    private void renderList(HttpServletRequest request, HttpServletResponse response,
            String custId) throws EsbException, ServletException, IOException {
        List benfList = listService.listBeneficiaries(custId);
        request.setAttribute("benfList", benfList);
        HttpSession session = request.getSession();
        Object flash = session.getAttribute("flashOnce");
        if (flash != null) {
            request.setAttribute("flashMsg", flash);
            session.removeAttribute("flashOnce");
        }
        forward(request, response, "/beneficiaryList.jsp");
    }

    private String hostMessage(String rc) {
        if ("0102".equals(rc)) return "A beneficiary with this IBAN already exists.";
        if ("0107".equals(rc)) return "Beneficiary refused by compliance vetting.";
        if ("0110".equals(rc)) return "Beneficiary book is full (max 50 entries).";
        return "Operation refused by the bank host (code " + rc + ").";
    }

    private void forward(HttpServletRequest request, HttpServletResponse response,
            String jsp) throws ServletException, IOException {
        RequestDispatcher rd = request.getRequestDispatcher(jsp);
        rd.forward(request, response);
    }

    private String custId(HttpServletRequest request) {
        HttpSession session = request.getSession(true);
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
