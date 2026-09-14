package com.demobank.legacy.dto;

import java.io.Serializable;
import java.math.BigDecimal;

/**
 * Account overview row DTO.
 *
 * Field names mirror the host copybook CBACCT01 (abbreviations kept on
 * purpose so the mapping to ESB_ACCT_LIST stays 1:1). Do NOT rename: the
 * JSPs and the JSON serializer rely on the getter names.
 *
 * @author gferri (2008)
 */
public class AcctOvwDTO implements Serializable {

    private static final long serialVersionUID = 1L;

    /** Account number, host format (12 digits, branch prefixed). */
    private String acctNo;
    /** IBAN presentation form, e.g. "IT00 DEMO 0101 0101 0000 0000 001". */
    private String acctIban;
    /** Short description from host, e.g. "CURRENT ACCOUNT". */
    private String acctDesc;
    /** ISO currency code, always EUR for domestic accounts. */
    private String ccyCd;
    /** Current (booked) balance. */
    private BigDecimal curBal;
    /** Available balance (booked minus holds). */
    private BigDecimal avlBal;
    /** Account status cd: A=active, B=blocked, C=closed. */
    private String staCd;

    public AcctOvwDTO() {
        // bean constructor
    }

    public String getAcctNo() { return acctNo; }
    public void setAcctNo(String acctNo) { this.acctNo = acctNo; }

    public String getAcctIban() { return acctIban; }
    public void setAcctIban(String acctIban) { this.acctIban = acctIban; }

    public String getAcctDesc() { return acctDesc; }
    public void setAcctDesc(String acctDesc) { this.acctDesc = acctDesc; }

    public String getCcyCd() { return ccyCd; }
    public void setCcyCd(String ccyCd) { this.ccyCd = ccyCd; }

    public BigDecimal getCurBal() { return curBal; }
    public void setCurBal(BigDecimal curBal) { this.curBal = curBal; }

    public BigDecimal getAvlBal() { return avlBal; }
    public void setAvlBal(BigDecimal avlBal) { this.avlBal = avlBal; }

    public String getStaCd() { return staCd; }
    public void setStaCd(String staCd) { this.staCd = staCd; }
}
