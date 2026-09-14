<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- Static FAQ (filler). Also mapped as the 500 error page in web.xml. --%>
<jsp:include page="header.jsp" />

<h1>Help &amp; FAQ</h1>

<h2>I cannot see my accounts</h2>
<p>
  Balances are retrieved from the central host. If the overview shows no
  accounts, retry in a few minutes; during nightly batch (00:30-01:30 CET)
  positions may be unavailable.
</p>

<h2>How long does a wire transfer take?</h2>
<p>
  SEPA transfers in EUR are settled on the next business day. Transfers
  entered after 17:30 CET are processed the following business day.
</p>

<h2>Is there a transfer limit?</h2>
<p>
  The default online limit is EUR 5,000.00 per day. Higher limits can be
  arranged at your branch.
</p>

<h2>Who do I contact?</h2>
<p>
  Customer service: 800 000 000 (Mon-Fri 8:00-20:00), or write from the
  <a href="messages.jsp">Messages</a> page.
</p>

<jsp:include page="footer.jsp" />
