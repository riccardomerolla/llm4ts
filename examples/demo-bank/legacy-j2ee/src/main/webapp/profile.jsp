<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- Customer profile (filler). Data is hard-coded demo content; the host
     profile inquiry (ESB_CUST_INQ) was never wired into this page. --%>
<jsp:include page="header.jsp" />

<%
    String custId = (String) session.getAttribute("custId");
    if (custId == null) custId = "CUST0042";
%>
<h1>Customer Profile</h1>

<table class="data" style="width: 60%;">
  <tr><th>Customer id</th><td><%= custId %></td></tr>
  <tr><th>Name</th><td>MARIO BIANCHI</td></tr>
  <tr><th>Address</th><td>VIA ROMA 1, 20100 MILANO (MI)</td></tr>
  <tr><th>Email</th><td>mario.bianchi@example.invalid</td></tr>
  <tr><th>Phone</th><td>+39 02 0000 0000</td></tr>
  <tr><th>Branch</th><td>0042 - MILANO CENTRO</td></tr>
</table>

<p class="small">
  To update your personal data please visit your branch with a valid id
  document. Online profile update is not yet available.
</p>

<jsp:include page="footer.jsp" />
