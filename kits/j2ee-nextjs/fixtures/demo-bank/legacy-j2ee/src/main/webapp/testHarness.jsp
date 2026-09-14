<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- DEAD PAGE. Developer scratch page for poking the servlets by hand.
     Should never have shipped to production (it did, release 2.3). Not
     linked from anywhere; security review DB-SEC-77 flagged it in 2012,
     removal still pending. --%>
<html>
<head>
<title>portal test harness - INTERNAL</title>
<script type="text/javascript" src="js/jquery-1.12.4.min.js"></script>
</head>
<body style="font-family: monospace;">
<h3>portal test harness (dev only)</h3>

<p>
  <a href="accountOverview?fmt=json">acct list json</a> |
  <a href="beneficiary">benf list</a> |
  <a href="transfer">trf step1</a>
</p>

<form method="post" action="transfer">
  <input type="hidden" name="step" value="1" />
  benfId <input type="text" name="benfId" value="B0001" size="6" />
  amt <input type="text" name="trfAmt" value="1.00" size="8" />
  ccy <input type="text" name="trfCcy" value="EUR" size="4" />
  <input type="submit" value="post step1" />
</form>

<pre id="out"></pre>
<script type="text/javascript">
// dump the acct json into the pre for eyeballing
$(function() {
  $.get("accountOverview", { fmt: "json" }, function(d) {
    $("#out").text(typeof d == "string" ? d : JSON.stringify(d));
  });
});
</script>

</body>
</html>
