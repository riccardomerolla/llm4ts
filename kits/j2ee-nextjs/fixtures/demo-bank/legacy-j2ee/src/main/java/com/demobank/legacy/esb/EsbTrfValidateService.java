package com.demobank.legacy.esb;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;

import com.demobank.legacy.web.TransferDraft;

/**
 * Wrapper around host service ESB_TRF_VAL (wire transfer pre-validation,
 * Cobol routine TRFVAL). Checks funds, limits, embargo, cut-off; computes
 * the fee and the first available value date. Does NOT move money.
 *
 * The draft is enriched in place with FEE-AMT and VAL-DT from the host so
 * step 2 (review) shows exactly what execution will use.
 *
 * @author lgreco (2011)
 */
public class EsbTrfValidateService {

    public static final String SVC_ID = "ESB_TRF_VAL";

    /**
     * @return host RC: "0000" when the transfer may proceed, otherwise a
     *         business rejection (e.g. 0201 insufficient funds, 0205 daily
     *         limit exceeded, 0207 embargo hit).
     */
    public String validate(String custId, TransferDraft draft) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        in.put("BENF-ID", draft.getBenfId());
        in.put("TRF-AMT", draft.getTrfAmt().toPlainString());
        in.put("TRF-CCY", draft.getTrfCcy());
        in.put("TRF-DESC", draft.getTrfDesc());
        in.put("VAL-DT", draft.getValDt());

        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);
        String rc = (String) out.get("HOST-RC");
        if ("0000".equals(rc)) {
            draft.setFeeAmt(new BigDecimal((String) out.get("FEE-AMT")));
            draft.setValDt((String) out.get("VAL-DT"));
        }
        return rc;
    }
}
