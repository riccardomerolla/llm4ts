<%@ page contentType="text/html; charset=ISO-8859-1" %>
<%@ taglib uri="http://java.sun.com/jsp/jstl/core" prefix="c" %>
<%-- HERO 2 (list): beneficiary management. Rendered by BeneficiaryServlet
     with "benfList" (list of BenfDTO). Delete goes back through the same
     servlet with action=delete. --%>
<jsp:include page="header.jsp" />

<h1>Beneficiaries</h1>

<c:if test="${not empty flashMsg}">
  <p class="msgOk"><c:out value="${flashMsg}" /></p>
</c:if>

<p><a class="btn" href="beneficiary?action=new">Add beneficiary</a></p>

<table class="data">
  <tr>
    <th>Name</th>
    <th>IBAN</th>
    <th>Bank</th>
    <th>Ccy</th>
    <th>Actions</th>
  </tr>
  <c:forEach var="b" items="${benfList}" varStatus="st">
    <tr class="${st.index % 2 == 1 ? 'odd' : ''}">
      <td><c:out value="${b.benfNm}" /></td>
      <td><c:out value="${b.benfIban}" /></td>
      <td><c:out value="${b.bankNm}" /></td>
      <td><c:out value="${b.ccyCd}" /></td>
      <td>
        <a href="beneficiary?action=edit&amp;benfId=${b.benfId}">Edit</a>
        &nbsp;
        <a href="beneficiary?action=delete&amp;benfId=${b.benfId}"
           onclick="return confirm('Delete beneficiary ${b.benfNm}?');">Delete</a>
      </td>
    </tr>
  </c:forEach>
  <c:if test="${empty benfList}">
    <tr><td colspan="5">No beneficiaries registered.</td></tr>
  </c:if>
</table>

<jsp:include page="footer.jsp" />
