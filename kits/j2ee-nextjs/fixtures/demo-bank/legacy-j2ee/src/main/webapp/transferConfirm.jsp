<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>
<%-- HERO 3, step 3 of 3: result screen. TransferServlet forwards here after
     ESB_TRF_EXEC with a TrfDTO in request attribute "trfRes"; the session
     draft has been cleared by then. --%>
<jsp:include page="header.jsp" />

<h1>Wire Transfer &mdash; Completed</h1>

<c:choose>
  <c:when test="${trfRes.status == 'OK'}">
    <p class="msgOk">Transfer accepted by the bank host.</p>
    <table class="data" style="width: 60%;">
      <tr><th>Reference</th><td><c:out value="${trfRes.trfRef}" /></td></tr>
      <tr><th>Beneficiary</th><td><c:out value="${trfRes.benfNm}" /></td></tr>
      <tr><th>Amount</th><td><c:out value="${trfRes.trfCcy}" /> <c:out value="${trfRes.trfAmt}" /></td></tr>
      <tr><th>Value date</th><td><c:out value="${trfRes.valDt}" /></td></tr>
    </table>
    <p>Keep the reference number for any enquiry with customer service.</p>
  </c:when>
  <c:otherwise>
    <p class="msgErr">
      The transfer was NOT executed:
      <c:out value="${trfRes.hostMsg}" /> (code <c:out value="${trfRes.hostRc}" />)
    </p>
    <p>No amount has been debited. Please retry later or contact your branch.</p>
  </c:otherwise>
</c:choose>

<p>
  <a class="btn" href="transfer">New transfer</a>
  <a class="btn btnGrey" href="accountOverview">Back to accounts</a>
</p>

<jsp:include page="footer.jsp" />
