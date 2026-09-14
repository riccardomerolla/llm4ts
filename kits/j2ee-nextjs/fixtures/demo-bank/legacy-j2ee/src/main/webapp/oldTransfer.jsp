<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- DEAD PAGE. Single-page transfer form, replaced by the 3-step wizard
     in release 2.4 (2011). Kept "just in case" for the branch kiosks and
     never removed. Posts to /doTransfer which no longer exists in web.xml. --%>
<jsp:include page="header.jsp" />

<h1>Wire Transfer</h1>

<form class="legacy" method="post" action="doTransfer">
  <div class="row">
    <label for="benfIban">Beneficiary IBAN</label>
    <input type="text" id="benfIban" name="benfIban" size="40"
           value="IT00 DEMO 0101 0101 0000 0000 001" />
  </div>
  <div class="row">
    <label for="benfNm">Beneficiary name</label>
    <input type="text" id="benfNm" name="benfNm" size="50" />
  </div>
  <div class="row">
    <label for="amt">Amount (EUR)</label>
    <input type="text" id="amt" name="amt" size="12" />
  </div>
  <div class="row">
    <label for="desc">Description</label>
    <input type="text" id="desc" name="desc" size="50" />
  </div>
  <div class="row">
    <input type="submit" class="btn" value="Execute transfer" />
  </div>
</form>

<p class="small">All fields are mandatory. Transfers over EUR 5,000.00 must be arranged at the branch.</p>

<jsp:include page="footer.jsp" />
