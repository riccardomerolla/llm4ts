<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ page import="com.demobank.legacy.web.TransferDraft" %>
<%-- HERO 3, step 2 of 3: review. All data comes from the TransferDraft in
     HttpSession (attribute "trfDraft"); nothing is re-posted except the
     confirmation itself. Direct GET without a draft bounces to step 1. --%>
<jsp:include page="header.jsp" />

<h1>Wire Transfer &mdash; Step 2 of 3: Review</h1>

<%
    TransferDraft draft = (TransferDraft) session.getAttribute("trfDraft");
    if (draft == null) {
        // Session expired or deep link: back to step 1.
        response.sendRedirect("transfer");
        return;
    }
%>

<table class="data" style="width: 60%;">
  <tr><th>Beneficiary</th><td><%= draft.getBenfNm() %></td></tr>
  <tr><th>IBAN</th><td><%= draft.getBenfIban() %></td></tr>
  <tr><th>Amount</th><td><%= draft.getTrfCcy() %> <%= draft.getTrfAmt() %></td></tr>
  <tr><th>Description</th><td><%= draft.getTrfDesc() == null ? "" : draft.getTrfDesc() %></td></tr>
  <tr><th>Value date</th><td><%= draft.getValDt() %></td></tr>
  <tr><th>Fee</th><td>EUR <%= draft.getFeeAmt() %> (standard SEPA)</td></tr>
</table>

<p class="msgErr">
  Please verify the details above. On confirmation the transfer is sent to
  the bank host and can no longer be amended online.
</p>

<form method="post" action="transfer">
  <input type="hidden" name="step" value="3" />
  <input type="submit" class="btn" value="Confirm transfer" />
  <input type="button" class="btn btnGrey" value="Back"
         onclick="window.location='transfer';" />
</form>

<jsp:include page="footer.jsp" />
