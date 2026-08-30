<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ page import="java.util.List" %>
<%@ page import="com.demobank.legacy.dto.BenfDTO" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>
<%-- HERO 3, step 1 of 3: wire transfer entry. Posts step=1 to TransferServlet
     which stores a TransferDraft in HttpSession. Scriptlet + JSTL mix is
     historical: the beneficiary combo predates the JSTL migration. --%>
<jsp:include page="header.jsp" />

<h1>Wire Transfer &mdash; Step 1 of 3</h1>

<c:if test="${not empty stepErr}">
  <p class="msgErr"><c:out value="${stepErr}" /></p>
</c:if>

<form id="trfForm" class="legacy" method="post" action="transfer">
  <input type="hidden" name="step" value="1" />
  <div class="row">
    <label for="benfId">Beneficiary</label>
    <select id="benfId" name="benfId">
      <option value="">-- select --</option>
<%
    // Legacy: combo rendered with a scriptlet since 2007 (pre-JSTL page).
    List benfCombo = (List) request.getAttribute("benfCombo");
    if (benfCombo != null) {
        for (int i = 0; i < benfCombo.size(); i++) {
            BenfDTO b = (BenfDTO) benfCombo.get(i);
%>
      <option value="<%= b.getBenfId() %>"><%= b.getBenfNm() %> - <%= b.getBenfIban() %></option>
<%
        }
    }
%>
    </select>
    <a href="beneficiary?action=new">new beneficiary</a>
  </div>
  <div class="row">
    <label for="trfAmt">Amount</label>
    <input type="text" id="trfAmt" name="trfAmt" size="12" value="<c:out value='${draft.trfAmt}' />" />
    <select id="trfCcy" name="trfCcy">
      <option value="EUR" selected="selected">EUR</option>
    </select>
  </div>
  <div class="row">
    <label for="trfDesc">Description</label>
    <input type="text" id="trfDesc" name="trfDesc" size="50" maxlength="140"
           value="<c:out value='${draft.trfDesc}' />" />
  </div>
  <div class="row">
    <label for="valDt">Value date</label>
    <input type="text" id="valDt" name="valDt" size="10" value="<c:out value='${draft.valDt}' />" />
    <span class="small">(dd/mm/yyyy, leave blank for first available)</span>
  </div>
  <div class="row">
    <input type="submit" class="btn" value="Continue" />
  </div>
</form>

<script type="text/javascript">
$(document).ready(function() {
  $("#trfForm").submit(function() {
    var ok = true;
    if (dbTrim($("#benfId").val()) == "") { dbMark("#benfId", "Select a beneficiary"); ok = false; }
    else dbUnmark("#benfId");
    if (!dbAmount("#trfAmt")) ok = false;
    // Description optional client-side; host rejects some characters,
    // server strips them silently (see TransferServlet.sanitizeDesc).
    return ok;
  });
});
</script>

<jsp:include page="footer.jsp" />
