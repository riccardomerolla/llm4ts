<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>
<%-- HERO 2 (form): add/edit beneficiary. Client-side jQuery validation
     (inline + validate.js) AND server-side validation in BeneficiaryServlet.
     The two rule sets overlap but are NOT identical on purpose:
       - client allows 70 chars for name, server allows 60 (DB-2988)
       - client IBAN check is shape-only, server also checks country IT/DE/FR
       - client tolerates decimal comma, server does not (DB-3302 pattern)
     "benf" request attribute holds the BenfDTO being edited (may be new). --%>
<jsp:include page="header.jsp" />

<h1><c:choose><c:when test="${empty benf.benfId}">Add beneficiary</c:when><c:otherwise>Edit beneficiary</c:otherwise></c:choose></h1>

<c:if test="${not empty srvErrs}">
  <ul>
    <c:forEach var="e" items="${srvErrs}">
      <li class="msgErr"><c:out value="${e}" /></li>
    </c:forEach>
  </ul>
</c:if>

<form id="benfForm" class="legacy" method="post" action="beneficiary">
  <input type="hidden" name="benfId" value="<c:out value='${benf.benfId}' />" />
  <div class="row">
    <label for="benfNm">Beneficiary name</label>
    <input type="text" id="benfNm" name="benfNm" size="50" maxlength="70"
           value="<c:out value='${benf.benfNm}' />" />
  </div>
  <div class="row">
    <label for="benfIban">IBAN</label>
    <input type="text" id="benfIban" name="benfIban" size="40"
           value="<c:out value='${benf.benfIban}' />" />
  </div>
  <div class="row">
    <label for="bankNm">Bank name</label>
    <input type="text" id="bankNm" name="bankNm" size="40"
           value="<c:out value='${benf.bankNm}' />" />
  </div>
  <div class="row">
    <label for="ccyCd">Currency</label>
    <select id="ccyCd" name="ccyCd">
      <option value="EUR" <c:if test="${benf.ccyCd == 'EUR'}">selected="selected"</c:if>>EUR</option>
      <option value="USD" <c:if test="${benf.ccyCd == 'USD'}">selected="selected"</c:if>>USD</option>
      <option value="GBP" <c:if test="${benf.ccyCd == 'GBP'}">selected="selected"</c:if>>GBP</option>
    </select>
  </div>
  <div class="row">
    <input type="submit" class="btn" value="Save" />
    <input type="button" class="btn btnGrey" value="Cancel"
           onclick="window.location='beneficiary';" />
  </div>
</form>

<script type="text/javascript">
$(document).ready(function() {
  $("#benfForm").submit(function() {
    var ok = true;
    // NB: client allows up to 70 chars, the host field is CHAR(60) --
    // servlet rejects instead of truncating. Kept as-is since 2011, see DB-2988.
    if (!dbRequired("#benfNm", "Beneficiary name is required")) ok = false;
    else if (!dbMaxLen("#benfNm", 70)) ok = false;
    if (!dbRequired("#benfIban", "IBAN is required")) ok = false;
    else if (!dbIbanShape("#benfIban")) ok = false;
    // bankNm optional on the client; server requires it for non-EUR.
    return ok;
  });
});
</script>

<jsp:include page="footer.jsp" />
