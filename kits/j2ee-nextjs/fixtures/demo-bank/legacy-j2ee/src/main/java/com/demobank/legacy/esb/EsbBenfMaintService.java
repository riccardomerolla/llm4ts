package com.demobank.legacy.esb;

import java.util.HashMap;
import java.util.Map;

import com.demobank.legacy.dto.BenfDTO;

/**
 * Wrapper around host service ESB_BENF_MAINT (beneficiary maintenance,
 * Cobol routine BENFMNT). One service, three ops -- the host multiplexes
 * on MAINT-OP: I=insert, U=update, D=delete.
 *
 * Business return codes seen in the wild:
 *   0000 ok
 *   0102 duplicate IBAN for customer
 *   0107 beneficiary vetting failed (embargo list)
 *   0110 book full (max 50 beneficiaries)
 *
 * @author rmasi (2010)
 */
public class EsbBenfMaintService {

    public static final String SVC_ID = "ESB_BENF_MAINT";

    /** Insert or update depending on whether dto.benfId is set. */
    public String save(String custId, BenfDTO dto) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        in.put("MAINT-OP", isEmpty(dto.getBenfId()) ? "I" : "U");
        in.put("BENF-ID", dto.getBenfId());
        in.put("BENF-NM", dto.getBenfNm());
        // Host stores the IBAN without spaces.
        in.put("BENF-IBAN", dto.getBenfIban() == null
                ? null : dto.getBenfIban().replaceAll(" ", ""));
        in.put("BANK-NM", dto.getBankNm());
        in.put("CCY-CD", dto.getCcyCd());

        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);
        String rc = (String) out.get("HOST-RC");
        if (!"0000".equals(rc)) {
            return rc; // business rejection, servlet renders the message
        }
        return "0000";
    }

    public String delete(String custId, String benfId) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        in.put("MAINT-OP", "D");
        in.put("BENF-ID", benfId);
        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);
        return (String) out.get("HOST-RC");
    }

    private boolean isEmpty(String s) {
        return s == null || s.trim().length() == 0;
    }
}
