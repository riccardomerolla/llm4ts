<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- Secure messages inbox (filler). Static demo rows; the real inbox
     servlet lives in the CRM webapp, not this portal. --%>
<jsp:include page="header.jsp" />

<h1>Messages</h1>

<table class="data">
  <tr>
    <th>Date</th>
    <th>From</th>
    <th>Subject</th>
  </tr>
  <tr>
    <td>02/01/2013</td>
    <td>DemoBank</td>
    <td>Your December statement is available</td>
  </tr>
  <tr class="odd">
    <td>18/12/2012</td>
    <td>DemoBank</td>
    <td>New security recommendations for online banking</td>
  </tr>
  <tr>
    <td>02/11/2012</td>
    <td>DemoBank</td>
    <td>Fee schedule update effective 01/01/2013</td>
  </tr>
</table>

<p><input type="button" class="btn" value="New message"
          onclick="alert('Messaging is handled by the branch CRM. Please call 800 000 000.');" /></p>

<jsp:include page="footer.jsp" />
