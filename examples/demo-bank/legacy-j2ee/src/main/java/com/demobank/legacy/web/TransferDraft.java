package com.demobank.legacy.web;

import java.io.Serializable;
import java.math.BigDecimal;

/**
 * Wire transfer wizard state, held in HttpSession under attribute
 * "trfDraft" between step 1 (entry), step 2 (review) and step 3
 * (execution). Cleared by TransferServlet after execution or abandon.
 *
 * Serializable because the app servers replicate sessions across the
 * cluster (session-timeout 10, see web.xml).
 *
 * @author lgreco (2011)
 */
public class TransferDraft implements Serializable {

    private static final long serialVersionUID = 1L;

    private String benfId;
    private String benfNm;
    private String benfIban;
    private BigDecimal trfAmt;
    private String trfCcy;
    private String trfDesc;
    private String valDt;
    /** Fee computed by ESB_TRF_VAL, shown on the review screen. */
    private BigDecimal feeAmt;
    /** Validation token from ESB_TRF_VAL, required by ESB_TRF_EXEC. */
    private String valToken;

    public TransferDraft() {
        // bean constructor
    }

    public String getBenfId() { return benfId; }
    public void setBenfId(String benfId) { this.benfId = benfId; }

    public String getBenfNm() { return benfNm; }
    public void setBenfNm(String benfNm) { this.benfNm = benfNm; }

    public String getBenfIban() { return benfIban; }
    public void setBenfIban(String benfIban) { this.benfIban = benfIban; }

    public BigDecimal getTrfAmt() { return trfAmt; }
    public void setTrfAmt(BigDecimal trfAmt) { this.trfAmt = trfAmt; }

    public String getTrfCcy() { return trfCcy; }
    public void setTrfCcy(String trfCcy) { this.trfCcy = trfCcy; }

    public String getTrfDesc() { return trfDesc; }
    public void setTrfDesc(String trfDesc) { this.trfDesc = trfDesc; }

    public String getValDt() { return valDt; }
    public void setValDt(String valDt) { this.valDt = valDt; }

    public BigDecimal getFeeAmt() { return feeAmt; }
    public void setFeeAmt(BigDecimal feeAmt) { this.feeAmt = feeAmt; }

    public String getValToken() { return valToken; }
    public void setValToken(String valToken) { this.valToken = valToken; }
}
