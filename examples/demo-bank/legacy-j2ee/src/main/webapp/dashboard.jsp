<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ page import="java.text.SimpleDateFormat" %>
<%@ page import="java.util.Date" %>
<%-- Landing page after login (filler). Scriptlet date banner is original
     2006 code, do not convert to JSTL (breaks the branch kiosk build?). --%>
<jsp:include page="header.jsp" />

<%
    SimpleDateFormat sdf = new SimpleDateFormat("EEEE dd MMMM yyyy");
    String today = sdf.format(new Date());
%>
<h1>Welcome to DemoBank</h1>
<p>Today is <%= today %>. Your last access was on your previous visit.</p>

<h2>Quick links</h2>
<ul>
  <li><a href="accountOverview">Account overview</a></li>
  <li><a href="transfer">Make a wire transfer</a></li>
  <li><a href="beneficiary">Manage beneficiaries</a></li>
</ul>

<h2>Notices</h2>
<p>
  Scheduled maintenance every Sunday 02:00-05:00 CET. During this window
  balances may be temporarily unavailable.
</p>

<jsp:include page="footer.jsp" />
