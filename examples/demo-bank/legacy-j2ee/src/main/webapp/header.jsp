<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%-- DemoBank shared header. Included from every page. Last touched 2013-05-17 (rmasi). --%>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1" />
<title>DemoBank Internet Banking</title>
<link rel="stylesheet" type="text/css" href="css/bank.css" />
<script type="text/javascript" src="js/jquery-1.12.4.min.js"></script>
<script type="text/javascript" src="js/validate.js"></script>
</head>
<body>
<div id="topbar">
  <span class="logo">DemoBank</span>
  <span class="userbox">
    Welcome, <%= session.getAttribute("custNm") == null ? "MARIO BIANCHI" : session.getAttribute("custNm") %>
    &nbsp;|&nbsp; <a href="login.jsp">Logout</a>
  </span>
</div>
<jsp:include page="nav.jsp" />
<div id="content">
