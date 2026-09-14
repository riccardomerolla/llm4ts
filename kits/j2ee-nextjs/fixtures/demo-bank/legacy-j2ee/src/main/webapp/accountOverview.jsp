<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/fmt" prefix="fmt" %>
<%-- HERO 1: account overview. Server-rendered from AccountOverviewServlet
     ("accts" request attribute, list of AcctOvwDTO) plus an AJAX refresh
     that re-reads balances as JSON. --%>
<jsp:include page="header.jsp" />

<h1>Account Overview</h1>
<p>Position as of <c:out value="${asOfTs}" /> &nbsp;
  <input type="button" id="btnRefresh" class="btn" value="Refresh balances" />
  <span id="refreshMsg"></span>
</p>

<table class="data" id="acctTable">
  <tr>
    <th>Account</th>
    <th>Description</th>
    <th>Ccy</th>
    <th class="num">Current balance</th>
    <th class="num">Available balance</th>
  </tr>
  <c:forEach var="a" items="${accts}" varStatus="st">
    <tr class="${st.index % 2 == 1 ? 'odd' : ''}">
      <td><c:out value="${a.acctNo}" /></td>
      <td><c:out value="${a.acctDesc}" /></td>
      <td><c:out value="${a.ccyCd}" /></td>
      <td class="num curBal"><fmt:formatNumber value="${a.curBal}" minFractionDigits="2" maxFractionDigits="2" /></td>
      <td class="num avlBal"><fmt:formatNumber value="${a.avlBal}" minFractionDigits="2" maxFractionDigits="2" /></td>
    </tr>
  </c:forEach>
  <c:if test="${empty accts}">
    <tr><td colspan="5">No accounts found for customer.</td></tr>
  </c:if>
</table>

<script type="text/javascript">
$(document).ready(function() {
  $("#btnRefresh").click(function() {
    $("#refreshMsg").text("Refreshing...");
    $.ajax({
      url: "accountOverview",
      type: "GET",
      data: { fmt: "json" },
      dataType: "json",
      cache: false,
      success: function(data) {
        // Row order from the ESB matches the rendered table (host keeps
        // acct order stable per customer), so update positionally.
        var rows = $("#acctTable tr").not(":first");
        for (var i = 0; i < data.accts.length && i < rows.length; i++) {
          $(rows[i]).find("td.curBal").text(data.accts[i].curBal);
          $(rows[i]).find("td.avlBal").text(data.accts[i].avlBal);
        }
        $("#refreshMsg").text("Updated " + data.asOfTs).removeClass("msgErr").addClass("msgOk");
      },
      error: function() {
        $("#refreshMsg").text("Refresh failed, please retry.").removeClass("msgOk").addClass("msgErr");
      }
    });
  });
});
</script>

<jsp:include page="footer.jsp" />
