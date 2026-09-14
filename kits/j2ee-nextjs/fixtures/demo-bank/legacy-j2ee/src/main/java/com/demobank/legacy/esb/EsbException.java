package com.demobank.legacy.esb;

/**
 * Transport-level ESB failure (router down, timeout, bridge error).
 * Business return codes travel inside the response map instead.
 */
public class EsbException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String esbRc;

    public EsbException(String message, String esbRc) {
        super(message);
        this.esbRc = esbRc;
    }

    public String getEsbRc() {
        return esbRc;
    }
}
