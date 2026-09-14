package com.demobank.legacy.esb;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;

import com.demobank.legacy.dto.TrfDTO;
import com.demobank.legacy.web.TransferDraft;

/**
 * Wrapper around host service ESB_TRF_EXEC (wire transfer execution,
 * Cobol routine TRFEXC). Debits the account and books the SEPA payment.
 * MUST be preceded by a successful ESB_TRF_VAL in the same session --
 * the host cross-checks the validation token (VAL-TOKEN).
 *
 * Idempotency: the host dedupes on (CUST-ID, VAL-TOKEN), so a double
 * submit of step 3 returns the original reference instead of paying twice.
 *
 * @author lgreco (2011)
 */
public class EsbTrfExecService {

    public static final String SVC_ID = "ESB_TRF_EXEC";

    public TrfDTO execute(String custId, TransferDraft draft) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        in.put("VAL-TOKEN", draft.getValToken());
        in.put("BENF-ID", draft.getBenfId());
        in.put("TRF-AMT", draft.getTrfAmt().toPlainString());
        in.put("TRF-CCY", draft.getTrfCcy());
        in.put("TRF-DESC", draft.getTrfDesc());
        in.put("VAL-DT", draft.getValDt());

        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);

        TrfDTO res = new TrfDTO();
        String rc = (String) out.get("HOST-RC");
        res.setHostRc(rc);
        res.setHostMsg((String) out.get("HOST-MSG"));
        res.setStatus("0000".equals(rc) ? "OK" : "KO");
        if ("0000".equals(rc)) {
            res.setTrfRef((String) out.get("TRF-REF"));
            res.setBenfNm(draft.getBenfNm());
            res.setBenfIban(draft.getBenfIban());
            res.setTrfAmt(draft.getTrfAmt());
            res.setTrfCcy(draft.getTrfCcy());
            res.setValDt((String) out.get("VAL-DT"));
            res.setFeeAmt(new BigDecimal((String) out.get("FEE-AMT")));
        }
        return res;
    }
}
