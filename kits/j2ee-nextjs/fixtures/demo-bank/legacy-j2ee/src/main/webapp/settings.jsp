<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- Settings page (filler). Toggles are rendered but wired to nothing:
     the save servlet was never built (ticket DB-1560, parked 2010). --%>
<jsp:include page="header.jsp" />

<h1>Settings</h1>

<form class="legacy" method="post" action="#">
  <div class="row">
    <label for="lang">Language</label>
    <select id="lang" name="lang">
      <option value="it" selected="selected">Italiano</option>
      <option value="en">English</option>
    </select>
  </div>
  <div class="row">
    <label for="stmtMode">Statement delivery</label>
    <select id="stmtMode" name="stmtMode">
      <option value="P">Paper</option>
      <option value="E" selected="selected">Electronic</option>
    </select>
  </div>
  <div class="row">
    <label for="smsAlert">SMS alerts</label>
    <input type="checkbox" id="smsAlert" name="smsAlert" checked="checked" />
    over threshold EUR
    <input type="text" name="smsThr" size="8" value="500.00" />
  </div>
  <div class="row">
    <input type="submit" class="btn" value="Save" onclick="alert('Settings service temporarily unavailable.'); return false;" />
  </div>
</form>

<jsp:include page="footer.jsp" />
