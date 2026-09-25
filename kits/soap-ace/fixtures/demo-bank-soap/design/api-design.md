# REST design: Demo Bank accounts and credit transfers

Status: approved

Hand-written reference design for the demo-bank-soap fixture: what a good
soap-design proposal looks like, and the golden input of the OpenAPI
projection tests.

## Design of record

```json apidesign
{
  "version": 1,
  "title": "Demo Bank accounts and credit transfers",
  "basePath": "/v1",
  "endpoints": [
    {
      "method": "GET",
      "path": "/accounts",
      "operationId": "listAccounts",
      "summary": "List the customer's current accounts",
      "sources": [
        "cercaConti"
      ],
      "parameters": [
        {
          "name": "X-Customer-Tax-Code",
          "in": "header",
          "required": true,
          "type": "string",
          "source": "codiceFiscale",
          "description": "The customer's codice fiscale; a header keeps it out of URLs and access logs."
        },
        {
          "name": "status",
          "in": "query",
          "required": false,
          "type": "string",
          "source": "stato",
          "enum": [
            "ACTIVE",
            "BLOCKED",
            "CLOSED"
          ],
          "enumMap": {
            "ATTIVO": "ACTIVE",
            "BLOCCATO": "BLOCKED",
            "ESTINTO": "CLOSED"
          }
        }
      ],
      "responses": [
        {
          "status": 200,
          "description": "The accounts",
          "model": "Account",
          "list": true,
          "source": "conto[]"
        }
      ],
      "errors": [
        {
          "status": 400,
          "code": "invalid-tax-code",
          "title": "The tax code is not valid",
          "from": [
            "KO01"
          ]
        }
      ],
      "evidence": [
        "analysis/cercaConti: stato SOSPESO outside the WSDL enumeration, mapped to SUSPENDED",
        "analysis/cercaConti: canale returned but not declared; not exposed"
      ]
    },
    {
      "method": "GET",
      "path": "/accounts/{iban}",
      "operationId": "getAccount",
      "summary": "One account with its overdraft",
      "sources": [
        "dettaglioConto"
      ],
      "parameters": [
        {
          "name": "iban",
          "in": "path",
          "required": true,
          "type": "string",
          "source": "iban"
        }
      ],
      "responses": [
        {
          "status": 200,
          "description": "The account",
          "model": "AccountDetail",
          "source": ""
        }
      ],
      "errors": [
        {
          "status": 404,
          "code": "account-not-found",
          "title": "No such account",
          "from": [
            "KO12"
          ]
        }
      ],
      "evidence": [
        "analysis/dettaglioConto: fido sent as xsi:nil, exposed as a nullable overdraftLimit"
      ]
    },
    {
      "method": "GET",
      "path": "/accounts/{iban}/movements",
      "operationId": "listMovements",
      "summary": "Booked movements in a date window, newest first",
      "sources": [
        "cercaMovimenti"
      ],
      "parameters": [
        {
          "name": "iban",
          "in": "path",
          "required": true,
          "type": "string",
          "source": "iban"
        },
        {
          "name": "bookingDateFrom",
          "in": "query",
          "required": true,
          "type": "string",
          "source": "dataDa",
          "format": "date"
        },
        {
          "name": "bookingDateTo",
          "in": "query",
          "required": true,
          "type": "string",
          "source": "dataA",
          "format": "date"
        },
        {
          "name": "page",
          "in": "query",
          "required": false,
          "type": "integer",
          "source": "paginazione.numeroPagina",
          "derivation": "defaults to 1"
        },
        {
          "name": "size",
          "in": "query",
          "required": false,
          "type": "integer",
          "source": "paginazione.dimensionePagina",
          "derivation": "defaults to 50, at most 100"
        }
      ],
      "responses": [
        {
          "status": 200,
          "description": "One page of movements",
          "model": "Movement",
          "list": true,
          "paged": true,
          "source": "movimento[]"
        }
      ],
      "errors": [],
      "evidence": [
        "analysis/cercaMovimenti: page-number pagination with ultimaPagina and an optional totaleRecord"
      ]
    },
    {
      "method": "POST",
      "path": "/credit-transfers",
      "operationId": "createCreditTransfer",
      "summary": "Register a SEPA credit transfer awaiting confirmation",
      "sources": [
        "inserisciBonifico"
      ],
      "parameters": [],
      "requestBody": {
        "model": "CreditTransferRequest",
        "required": true
      },
      "responses": [
        {
          "status": 201,
          "description": "Registered, pending confirmation",
          "model": "CreditTransfer",
          "source": ""
        }
      ],
      "errors": [
        {
          "status": 422,
          "code": "transfer-rejected",
          "title": "The transfer cannot be registered",
          "from": [
            "ServizioFault"
          ]
        }
      ],
      "evidence": []
    },
    {
      "method": "POST",
      "path": "/credit-transfers/{transferId}/confirmation",
      "operationId": "confirmCreditTransfer",
      "summary": "Confirm a registered transfer with the OTP (SCA)",
      "sources": [
        "confermaBonifico"
      ],
      "parameters": [
        {
          "name": "transferId",
          "in": "path",
          "required": true,
          "type": "string",
          "source": "idBonifico"
        }
      ],
      "requestBody": {
        "model": "TransferConfirmationRequest",
        "required": true
      },
      "responses": [
        {
          "status": 200,
          "description": "Confirmed",
          "model": "TransferConfirmation",
          "source": ""
        }
      ],
      "errors": [
        {
          "status": 422,
          "code": "invalid-otp",
          "title": "The OTP is not valid",
          "from": [
            "KO17"
          ]
        }
      ],
      "evidence": [
        "analysis/confermaBonifico: KO17 arrives inside an HTTP 200 with esito; mapped to 422 invalid-otp"
      ]
    },
    {
      "method": "POST",
      "path": "/credit-transfers/{transferId}/revocation",
      "operationId": "revokeCreditTransfer",
      "summary": "Revoke a transfer not yet executed",
      "sources": [
        "revocaBonifico"
      ],
      "parameters": [
        {
          "name": "transferId",
          "in": "path",
          "required": true,
          "type": "string",
          "source": "idBonifico"
        }
      ],
      "responses": [
        {
          "status": 200,
          "description": "Revoked",
          "model": "TransferRevocation",
          "source": ""
        }
      ],
      "errors": [
        {
          "status": 409,
          "code": "transfer-already-executed",
          "title": "The transfer was already executed",
          "from": [
            "ServizioFault"
          ]
        }
      ],
      "evidence": [
        "analysis/revocaBonifico: ServizioFault KO31 when the transfer was executed"
      ]
    }
  ],
  "models": [
    {
      "name": "Amount",
      "description": "A monetary amount: decimal string and ISO 4217 currency.",
      "sourceType": "ImportoType",
      "properties": [
        {
          "name": "amount",
          "type": "string",
          "required": true,
          "source": "valore",
          "format": "decimal"
        },
        {
          "name": "currency",
          "type": "string",
          "required": true,
          "source": "divisa"
        }
      ]
    },
    {
      "name": "Account",
      "description": "A current account (conto).",
      "sourceType": "ContoType",
      "properties": [
        {
          "name": "iban",
          "type": "string",
          "required": true,
          "source": "iban"
        },
        {
          "name": "holderName",
          "type": "string",
          "required": true,
          "source": "intestatario"
        },
        {
          "name": "taxCode",
          "type": "string",
          "required": true,
          "source": "codiceFiscale"
        },
        {
          "name": "balance",
          "type": "object",
          "required": true,
          "source": "saldo",
          "ref": "Amount"
        },
        {
          "name": "status",
          "type": "string",
          "required": true,
          "source": "stato",
          "enum": [
            "ACTIVE",
            "BLOCKED",
            "CLOSED",
            "SUSPENDED"
          ],
          "enumMap": {
            "ATTIVO": "ACTIVE",
            "BLOCCATO": "BLOCKED",
            "ESTINTO": "CLOSED",
            "SOSPESO": "SUSPENDED"
          },
          "description": "SUSPENDED is not in the WSDL enumeration but the service returns it (analysis/cercaConti)."
        },
        {
          "name": "openingDate",
          "type": "string",
          "required": true,
          "source": "dataApertura",
          "format": "date"
        },
        {
          "name": "branch",
          "type": "string",
          "required": false,
          "source": "filiale"
        }
      ]
    },
    {
      "name": "AccountDetail",
      "sourceType": "dettaglioContoResponse",
      "properties": [
        {
          "name": "account",
          "type": "object",
          "required": true,
          "source": "conto",
          "ref": "Account"
        },
        {
          "name": "overdraftLimit",
          "type": "object",
          "required": false,
          "source": "fido",
          "ref": "Amount",
          "nullable": true,
          "description": "Null when the account has no overdraft (sent as xsi:nil)."
        }
      ]
    },
    {
      "name": "Movement",
      "sourceType": "MovimentoType",
      "properties": [
        {
          "name": "id",
          "type": "string",
          "required": true,
          "source": "idMovimento"
        },
        {
          "name": "bookingDate",
          "type": "string",
          "required": true,
          "source": "dataContabile",
          "format": "date"
        },
        {
          "name": "valueDate",
          "type": "string",
          "required": true,
          "source": "dataValuta",
          "format": "date"
        },
        {
          "name": "amount",
          "type": "object",
          "required": true,
          "source": "importo",
          "ref": "Amount"
        },
        {
          "name": "direction",
          "type": "string",
          "required": true,
          "source": "segno",
          "enum": [
            "DEBIT",
            "CREDIT"
          ],
          "enumMap": {
            "D": "DEBIT",
            "A": "CREDIT"
          }
        },
        {
          "name": "reason",
          "type": "string",
          "required": true,
          "source": "causale"
        },
        {
          "name": "description",
          "type": "string",
          "required": false,
          "source": "descrizione"
        }
      ]
    },
    {
      "name": "CreditTransferRequest",
      "sourceType": "inserisciBonifico",
      "properties": [
        {
          "name": "debtorIban",
          "type": "string",
          "required": true,
          "source": "ibanOrdinante"
        },
        {
          "name": "creditorName",
          "type": "string",
          "required": true,
          "source": "beneficiario.nome"
        },
        {
          "name": "creditorIban",
          "type": "string",
          "required": true,
          "source": "beneficiario.iban"
        },
        {
          "name": "amount",
          "type": "object",
          "required": true,
          "source": "importo",
          "ref": "Amount"
        },
        {
          "name": "remittanceInformation",
          "type": "string",
          "required": true,
          "source": "causale"
        },
        {
          "name": "executionDate",
          "type": "string",
          "required": false,
          "source": "dataEsecuzione",
          "format": "date"
        }
      ]
    },
    {
      "name": "CreditTransfer",
      "sourceType": "inserisciBonificoResponse",
      "properties": [
        {
          "name": "id",
          "type": "string",
          "required": true,
          "source": "idBonifico"
        },
        {
          "name": "status",
          "type": "string",
          "required": true,
          "source": "stato",
          "enum": [
            "PENDING_CONFIRMATION",
            "CONFIRMED",
            "EXECUTED",
            "REVOKED",
            "REJECTED"
          ],
          "enumMap": {
            "INSERITO": "PENDING_CONFIRMATION",
            "CONFERMATO": "CONFIRMED",
            "ESEGUITO": "EXECUTED",
            "REVOCATO": "REVOKED",
            "RIFIUTATO": "REJECTED"
          }
        },
        {
          "name": "fees",
          "type": "object",
          "required": false,
          "source": "commissioni",
          "ref": "Amount"
        }
      ]
    },
    {
      "name": "TransferConfirmationRequest",
      "sourceType": "confermaBonifico",
      "properties": [
        {
          "name": "otp",
          "type": "string",
          "required": true,
          "source": "codiceOtp"
        }
      ]
    },
    {
      "name": "TransferConfirmation",
      "sourceType": "confermaBonificoResponse",
      "properties": [
        {
          "name": "status",
          "type": "string",
          "required": true,
          "source": "stato",
          "enum": [
            "PENDING_CONFIRMATION",
            "CONFIRMED",
            "EXECUTED",
            "REVOKED",
            "REJECTED"
          ],
          "enumMap": {
            "INSERITO": "PENDING_CONFIRMATION",
            "CONFERMATO": "CONFIRMED",
            "ESEGUITO": "EXECUTED",
            "REVOCATO": "REVOKED",
            "RIFIUTATO": "REJECTED"
          }
        },
        {
          "name": "transactionReference",
          "type": "string",
          "required": false,
          "source": "cro"
        }
      ]
    },
    {
      "name": "TransferRevocation",
      "sourceType": "revocaBonificoResponse",
      "properties": [
        {
          "name": "status",
          "type": "string",
          "required": true,
          "source": "stato",
          "enum": [
            "PENDING_CONFIRMATION",
            "CONFIRMED",
            "EXECUTED",
            "REVOKED",
            "REJECTED"
          ],
          "enumMap": {
            "INSERITO": "PENDING_CONFIRMATION",
            "CONFERMATO": "CONFIRMED",
            "ESEGUITO": "EXECUTED",
            "REVOCATO": "REVOKED",
            "RIFIUTATO": "REJECTED"
          }
        }
      ]
    }
  ],
  "excluded": [],
  "notes": [
    "The customer is identified by a header until the gateway derives it from the access token."
  ]
}
```
