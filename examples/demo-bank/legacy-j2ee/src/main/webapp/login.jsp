<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- Login shell (filler). Authentication is out of scope for this fixture:
     the form posts to the container-managed j_security_check stub and
     nothing checks it. Welcome page per web.xml. --%>
<jsp:include page="header.jsp" />

<h1>Internet Banking Login</h1>

<form class="legacy" method="post" action="j_security_check">
  <div class="row">
    <label for="j_username">Customer id</label>
    <input type="text" id="j_username" name="j_username" size="20" value="CUST0042" />
  </div>
  <div class="row">
    <label for="j_password">PIN</label>
    <input type="password" id="j_password" name="j_password" size="20" />
  </div>
  <div class="row">
    <input type="submit" class="btn" value="Login" />
  </div>
</form>

<p class="small">
  Forgot your PIN? Call 800 000 000 or visit your branch with a valid id
  document. Never share your PIN with anyone: DemoBank staff will never ask
  for it.
</p>

<jsp:include page="footer.jsp" />
