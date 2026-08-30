package com.demobank.legacy.esb;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.demobank.legacy.dto.AcctOvwDTO;

/**
 * Wrapper around host service ESB_ACCT_LIST (account position inquiry,
 * Cobol routine ACCTLST on the core banking host).
 *
 * Request copybook fields: CUST-ID.
 * Response: repeating group ACCT-ROW (ACCT-NO, ACCT-IBAN, ACCT-DESC,
 * CCY-CD, CUR-BAL, AVL-BAL, STA-CD), max 20 occurrences.
 *
 * @author gferri (2008)
 */
public class EsbAcctListService {

    public static final String SVC_ID = "ESB_ACCT_LIST";

    /**
     * List all accounts for a customer, closed ones excluded host-side.
     */
    public List listAccounts(String custId) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);

        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);

        List rows = (List) out.get("ACCT-ROW");
        List result = new ArrayList();
        if (rows != null) {
            for (int i = 0; i < rows.size(); i++) {
                Map r = (Map) rows.get(i);
                AcctOvwDTO dto = new AcctOvwDTO();
                dto.setAcctNo((String) r.get("ACCT-NO"));
                dto.setAcctIban((String) r.get("ACCT-IBAN"));
                dto.setAcctDesc((String) r.get("ACCT-DESC"));
                dto.setCcyCd((String) r.get("CCY-CD"));
                // Host sends amounts as implied-decimal strings.
                dto.setCurBal(new BigDecimal((String) r.get("CUR-BAL")));
                dto.setAvlBal(new BigDecimal((String) r.get("AVL-BAL")));
                dto.setStaCd((String) r.get("STA-CD"));
                result.add(dto);
            }
        }
        return result;
    }
}
