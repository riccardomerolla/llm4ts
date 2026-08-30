/*
 * DemoBank shared form validation helpers.
 * Hand-rolled long before any validation plugin was approved by the
 * architecture board (see ticket DB-1187). Every page wires these up
 * slightly differently -- do not "clean up" without regression testing
 * beneficiaryEdit.jsp and transferStep1.jsp.
 *
 * History:
 *   2009-03-12 gferri   initial version
 *   2010-11-02 rmasi    IBAN check for SEPA go-live
 *   2012-06-21 lgreco   amount check, decimal comma tolerated
 */

function dbTrim(s) {
  if (s == null) return ""
  return String(s).replace(/^\s+|\s+$/g, "")
}

/* Required field: returns true when non-empty, otherwise marks the field. */
function dbRequired(fld, msg) {
  var v = dbTrim($(fld).val())
  if (v.length == 0) {
    dbMark(fld, msg || "Required field")
    return false
  }
  dbUnmark(fld)
  return true
}

/* Very loose IBAN shape check: 2 letters, 2 digits, then 10..30 chars.
 * The REAL check is on the host side (ESB), this is only cosmetic.
 * Spaces are tolerated and stripped. */
function dbIbanShape(fld) {
  var v = dbTrim($(fld).val()).replace(/ /g, "").toUpperCase()
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(v)) {
    dbMark(fld, "IBAN format not recognised")
    return false
  }
  dbUnmark(fld)
  return true
}

/* Amount: positive, max 2 decimals, comma or dot accepted.
 * NB: server side only accepts the dot -- known mismatch, ticket DB-3302. */
function dbAmount(fld) {
  var v = dbTrim($(fld).val()).replace(",", ".")
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(v) || parseFloat(v) <= 0) {
    dbMark(fld, "Enter a positive amount (max 2 decimals)")
    return false
  }
  dbUnmark(fld)
  return true
}

/* Max length helper used by the beneficiary name field. */
function dbMaxLen(fld, n) {
  var v = dbTrim($(fld).val())
  if (v.length > n) {
    dbMark(fld, "Maximum " + n + " characters")
    return false
  }
  dbUnmark(fld)
  return true
}

function dbMark(fld, msg) {
  $(fld).addClass("fldErr")
  var id = $(fld).attr("id")
  if ($("#err_" + id).length == 0) {
    $(fld).after('<span class="errMsg" id="err_' + id + '"></span>')
  }
  $("#err_" + id).text(msg)
}

function dbUnmark(fld) {
  $(fld).removeClass("fldErr")
  var id = $(fld).attr("id")
  $("#err_" + id).remove()
}
