package com.demobank.legacy.dto;

import java.io.Serializable;

/**
 * Beneficiary DTO for list and maintenance (ESB_BENF_LIST / ESB_BENF_MAINT).
 * Field abbreviations follow host copybook CBBENF02.
 *
 * @author rmasi (2010)
 */
public class BenfDTO implements Serializable {

    private static final long serialVersionUID = 1L;

    /** Beneficiary id assigned by the host, e.g. "B0001". */
    private String benfId;
    /** Beneficiary display name, host field CHAR(60). */
    private String benfNm;
    /** Beneficiary IBAN, stored without spaces on the host. */
    private String benfIban;
    /** Beneficiary bank display name (optional for EUR/SEPA). */
    private String bankNm;
    /** Preferred currency for transfers to this beneficiary. */
    private String ccyCd;
    /** Y when the beneficiary passed host-side vetting. */
    private String vrfFlg;

    public BenfDTO() {
        // bean constructor
    }

    public String getBenfId() { return benfId; }
    public void setBenfId(String benfId) { this.benfId = benfId; }

    public String getBenfNm() { return benfNm; }
    public void setBenfNm(String benfNm) { this.benfNm = benfNm; }

    public String getBenfIban() { return benfIban; }
    public void setBenfIban(String benfIban) { this.benfIban = benfIban; }

    public String getBankNm() { return bankNm; }
    public void setBankNm(String bankNm) { this.bankNm = bankNm; }

    public String getCcyCd() { return ccyCd; }
    public void setCcyCd(String ccyCd) { this.ccyCd = ccyCd; }

    public String getVrfFlg() { return vrfFlg; }
    public void setVrfFlg(String vrfFlg) { this.vrfFlg = vrfFlg; }
}
