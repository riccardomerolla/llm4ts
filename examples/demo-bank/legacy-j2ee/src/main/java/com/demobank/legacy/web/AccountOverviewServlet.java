package com.demobank.legacy.web;

import java.io.IOException;
import java.io.PrintWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;

import javax.servlet.RequestDispatcher;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

import com.demobank.legacy.dto.AcctOvwDTO;
import com.demobank.legacy.esb.EsbAcctListService;
import com.demobank.legacy.esb.EsbException;

/**
 * HERO 1 controller. GET /accountOverview
 *
 * Two response modes on the same mapping (period-typical):
 *   - default: fetch positions, put "accts" + "asOfTs" in request scope,
 *     forward to accountOverview.jsp (server-rendered JSTL table)
 *   - fmt=json: hand-rolled JSON for the jQuery balance refresh
 *
 * ESB dependency: ESB_ACCT_LIST via EsbAcctListService.
 */
public class AccountOverviewServlet extends HttpServlet {

    private static final long serialVersionUID = 1L;

    private final EsbAcctListService acctListService = new EsbAcctListService();

    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        HttpSession session = request.getSession(true);
        String custId = (String) session.getAttribute("custId");
        if (custId == null) {
            custId = "CUST0042"; // fixture default, real portal redirects to login
            session.setAttribute("custId", custId);
        }

        List accts;
        try {
            accts = acctListService.listAccounts(custId);
        } catch (EsbException e) {
            // Legacy behaviour: log to stdout and render an empty list.
            System.out.println("ESB_ACCT_LIST failed rc=" + e.getEsbRc()
                    + " msg=" + e.getMessage());
            accts = new java.util.ArrayList();
        }

        String asOfTs = new SimpleDateFormat("dd/MM/yyyy HH:mm:ss").format(new Date());

        if ("json".equals(request.getParameter("fmt"))) {
            writeJson(response, accts, asOfTs);
            return;
        }

        request.setAttribute("accts", accts);
        request.setAttribute("asOfTs", asOfTs);
        RequestDispatcher rd = request.getRequestDispatcher("/accountOverview.jsp");
        rd.forward(request, response);
    }

    /**
     * Hand-rolled JSON (predates any JSON library approval, DB-1893).
     * Escaping is minimal because host descriptions are uppercase A-Z0-9.
     */
    private void writeJson(HttpServletResponse response, List accts, String asOfTs)
            throws IOException {
        response.setContentType("application/json");
        response.setHeader("Cache-Control", "no-cache");
        PrintWriter out = response.getWriter();
        out.print("{\"asOfTs\":\"" + asOfTs + "\",\"accts\":[");
        for (int i = 0; i < accts.size(); i++) {
            AcctOvwDTO a = (AcctOvwDTO) accts.get(i);
            if (i > 0) out.print(",");
            out.print("{\"acctNo\":\"" + a.getAcctNo() + "\"");
            out.print(",\"ccyCd\":\"" + a.getCcyCd() + "\"");
            out.print(",\"curBal\":\"" + a.getCurBal().toPlainString() + "\"");
            out.print(",\"avlBal\":\"" + a.getAvlBal().toPlainString() + "\"}");
        }
        out.print("]}");
        out.flush();
    }
}
