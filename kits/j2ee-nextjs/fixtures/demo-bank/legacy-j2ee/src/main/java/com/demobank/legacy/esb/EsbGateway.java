package com.demobank.legacy.esb;

import java.util.Map;

/**
 * Thin client for the DemoBank ESB router. Every host service is addressed
 * by its service id (the Cobol-ish routine name, e.g. "ESB_ACCT_LIST").
 *
 * In production this speaks the fixed-length message protocol over the
 * MQ bridge (endpoint from context-param demobank.esb.endpoint). In this
 * synthetic fixture it is a stub: the wrappers are what matter, the wire
 * never happens.
 *
 * @author esb-team (2007)
 */
public final class EsbGateway {

    private static final EsbGateway INSTANCE = new EsbGateway();

    public static EsbGateway getInstance() {
        return INSTANCE;
    }

    private EsbGateway() {
        // singleton since 2007; the app server pools nothing here
    }

    /**
     * Invoke a host service. Input and output are flat field maps keyed by
     * copybook field name; conversion to/from the fixed-length host record
     * is done by the (notional) message dictionary.
     *
     * @param svcId host service id, e.g. "ESB_TRF_EXEC"
     * @param in    request fields (copybook names)
     * @return response fields, always containing HOST-RC and HOST-MSG
     * @throws EsbException when the router is unreachable or times out
     */
    public Map invoke(String svcId, Map in) throws EsbException {
        // Fixture stub. Real implementation: build fixed-length record,
        // send via MQ bridge, parse response, map RC != 0000 to EsbException
        // for transport-level codes only (90xx range).
        throw new EsbException("ESB router not available in fixture", "9001");
    }
}
