package com.demobank.legacy.esb;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.demobank.legacy.dto.BenfDTO;

/**
 * Wrapper around host service ESB_BENF_LIST (beneficiary book inquiry,
 * Cobol routine BENFLST).
 *
 * Request: CUST-ID, optional BENF-ID for a single-row read.
 * Response: repeating group BENF-ROW (BENF-ID, BENF-NM, BENF-IBAN,
 * BANK-NM, CCY-CD, VRF-FLG), max 50 occurrences.
 *
 * @author rmasi (2010)
 */
public class EsbBenfListService {

    public static final String SVC_ID = "ESB_BENF_LIST";

    public List listBeneficiaries(String custId) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);
        return toDtos((List) out.get("BENF-ROW"));
    }

    /** Single beneficiary read; returns null when the host says not found. */
    public BenfDTO getBeneficiary(String custId, String benfId) throws EsbException {
        Map in = new HashMap();
        in.put("CUST-ID", custId);
        in.put("BENF-ID", benfId);
        Map out = EsbGateway.getInstance().invoke(SVC_ID, in);
        List dtos = toDtos((List) out.get("BENF-ROW"));
        return dtos.isEmpty() ? null : (BenfDTO) dtos.get(0);
    }

    private List toDtos(List rows) {
        List result = new ArrayList();
        if (rows != null) {
            for (int i = 0; i < rows.size(); i++) {
                Map r = (Map) rows.get(i);
                BenfDTO dto = new BenfDTO();
                dto.setBenfId((String) r.get("BENF-ID"));
                dto.setBenfNm((String) r.get("BENF-NM"));
                dto.setBenfIban((String) r.get("BENF-IBAN"));
                dto.setBankNm((String) r.get("BANK-NM"));
                dto.setCcyCd((String) r.get("CCY-CD"));
                dto.setVrfFlg((String) r.get("VRF-FLG"));
                result.add(dto);
            }
        }
        return result;
    }
}
