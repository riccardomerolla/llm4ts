package com.demobank.legacy.dto;

import java.io.Serializable;
import java.math.BigDecimal;

/**
 * Wire transfer result DTO, populated from ESB_TRF_VAL / ESB_TRF_EXEC
 * responses (host copybook CBTRF03). Rendered by transferConfirm.jsp.
 *
 * @author lgreco (2011)
 */
public class TrfDTO implements Serializable {

    private static final long serialVersionUID = 1L;

    /** Host transfer reference, e.g. "TRF20130115000042". */
    private String trfRef;
    /** OK or KO after execution. */
    private String status;
    /** Host return code, "0000" on success. */
    private String hostRc;
    /** Host message text (uppercase, host encoding). */
    private String hostMsg;
    /** Echoed beneficiary name. */
    private String benfNm;
    /** Echoed beneficiary IBAN. */
    private String benfIban;
    /** Transfer amount. */
    private BigDecimal trfAmt;
    /** Transfer currency (EUR only online). */
    private String trfCcy;
    /** Settlement value date, dd/MM/yyyy presentation form. */
    private String valDt;
    /** Fee charged, standard SEPA schedule. */
    private BigDecimal feeAmt;

    public TrfDTO() {
        // bean constructor
    }

    public String getTrfRef() { return trfRef; }
    public void setTrfRef(String trfRef) { this.trfRef = trfRef; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public String getHostRc() { return hostRc; }
    public void setHostRc(String hostRc) { this.hostRc = hostRc; }

    public String getHostMsg() { return hostMsg; }
    public void setHostMsg(String hostMsg) { this.hostMsg = hostMsg; }

    public String getBenfNm() { return benfNm; }
    public void setBenfNm(String benfNm) { this.benfNm = benfNm; }

    public String getBenfIban() { return benfIban; }
    public void setBenfIban(String benfIban) { this.benfIban = benfIban; }

    public BigDecimal getTrfAmt() { return trfAmt; }
    public void setTrfAmt(BigDecimal trfAmt) { this.trfAmt = trfAmt; }

    public String getTrfCcy() { return trfCcy; }
    public void setTrfCcy(String trfCcy) { this.trfCcy = trfCcy; }

    public String getValDt() { return valDt; }
    public void setValDt(String valDt) { this.valDt = valDt; }

    public BigDecimal getFeeAmt() { return feeAmt; }
    public void setFeeAmt(BigDecimal feeAmt) { this.feeAmt = feeAmt; }
}
