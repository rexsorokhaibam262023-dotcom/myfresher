/**
 * =========================================================================
 * MSAP 53rd Freshers' Meet 2026 - Google Apps Script Integration
 * =========================================================================
 * This script runs in Google Sheets (or directly in Google Forms) and triggers
 * whenever an attendee completes the registration form.
 *
 * It extracts attendee data, assigns the unique Google Form Response ID,
 * and calls the MSAP Node.js / MySQL backend API webhook with HMAC/Bearer token.
 *
 * HOW TO SET UP:
 * 1. Open your Google Form or the linked Google Sheet.
 * 2. Click "Extensions" > "Apps Script".
 * 3. Replace any default code with the contents of this file.
 * 4. Configure Script Properties ("Project Settings" > "Script Properties"):
 *      BACKEND_URL    = https://YOUR-APP-DOMAIN.run.app (or your public backend URL)
 *      WEBHOOK_SECRET = msap_google_sheets_secret_token_2026 (matching .env)
 * 5. Set up an installable trigger:
 *      - Click the clock icon ("Triggers") on the left sidebar.
 *      - Click "Add Trigger".
 *      - Select Function: onFormSubmit
 *      - Select Event Source: From spreadsheet (or From form)
 *      - Select Event Type: On form submit
 *      - Click "Save" and grant required permissions.
 * =========================================================================
 */

// Configuration fallback (Prefer setting these in Project Settings > Script Properties)
const CONFIG = {
  DEFAULT_BACKEND_URL: "https://YOUR-APP-DOMAIN.run.app",
  DEFAULT_WEBHOOK_SECRET: "msap_google_sheets_secret_token_2026",
};

/**
 * Triggered automatically when an attendee submits the Google Form
 * @param {Object} e - Event object provided by Google Forms / Sheets trigger
 */
function onFormSubmit(e) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const backendUrl = properties.getProperty("BACKEND_URL") || CONFIG.DEFAULT_BACKEND_URL;
    const webhookSecret = properties.getProperty("WEBHOOK_SECRET") || CONFIG.DEFAULT_WEBHOOK_SECRET;

    const payload = extractFormData(e);

    Logger.log("Transmitting registration for: " + payload.fullName + " (" + payload.email + ")");

    const endpoint = backendUrl.replace(/\/+$/, "") + "/api/webhook/google-form";

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        "x-webhook-token": webhookSecret,
        "User-Agent": "MSAP-Apps-Script-SyncEngine/3.0",
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    const response = UrlFetchApp.fetch(endpoint, options);
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();

    Logger.log("Response [" + statusCode + "]: " + responseText);

    if (statusCode >= 200 && statusCode < 300) {
      const data = JSON.parse(responseText);
      Logger.log("Successfully registered! Ticket ID: " + data.ticketId);

      // Optional: Write generated Ticket ID and secure token back into Google Sheet
      writebackToSheet(e, data);
    } else {
      Logger.log("Backend error: " + responseText);
    }
  } catch (err) {
    Logger.log("onFormSubmit Error: " + err.toString());
  }
}

/**
 * Extracts normalized data from the Form Submission event
 */
function extractFormData(e) {
  let fullName = "";
  let phone = "";
  let email = "";
  let college = "";
  let category = "FRESHER";
  let rollId = "";
  let utr = "";
  let responseId = "";

  if (e && e.response) {
    // Direct Google Form trigger
    responseId = e.response.getId();
    email = e.response.getRespondentEmail() || "";
    const itemResponses = e.response.getItemResponses();

    for (let i = 0; i < itemResponses.length; i++) {
      const title = itemResponses[i].getItem().getTitle().toLowerCase();
      const answer = itemResponses[i].getResponse();

      if (title.includes("name")) fullName = answer;
      else if (title.includes("phone") || title.includes("mobile") || title.includes("whatsapp")) phone = answer;
      else if (title.includes("email") && !email) email = answer;
      else if (title.includes("college") || title.includes("dept") || title.includes("department")) college = answer;
      else if (title.includes("category") || title.includes("cohort")) {
        category = answer.toString().toUpperCase().includes("SENIOR") ? "SENIOR" : "FRESHER";
      } else if (title.includes("roll") || title.includes("student id")) rollId = answer;
      else if (title.includes("utr") || title.includes("transaction") || title.includes("payment")) utr = answer;
    }
  } else if (e && e.namedValues) {
    // Linked Google Sheet trigger (namedValues map question header to answer array)
    const getVal = (keyword) => {
      for (const key of Object.keys(e.namedValues)) {
        if (key.toLowerCase().includes(keyword.toLowerCase())) {
          return e.namedValues[key][0] || "";
        }
      }
      return "";
    };

    fullName = getVal("name");
    phone = getVal("phone") || getVal("mobile") || getVal("whatsapp");
    email = getVal("email");
    college = getVal("college") || getVal("dept") || getVal("department") || "MSAP Architecture";
    const catVal = (getVal("category") || getVal("cohort")).toUpperCase();
    category = catVal.includes("SENIOR") ? "SENIOR" : "FRESHER";
    rollId = getVal("roll") || getVal("id");
    utr = getVal("utr") || getVal("transaction") || getVal("txn");
    
    // Generate or fetch unique response ID
    const row = e.range ? e.range.getRow() : new Date().getTime();
    responseId = "GSHEET_ROW_" + row + "_" + new Date().getTime();
  } else {
    // Fallback test payload
    responseId = "TEST_" + new Date().getTime();
    fullName = "Test Candidate";
    phone = "+91 9876543210";
    email = "test.candidate@msap.edu.in";
    college = "B.Arch - Architecture";
    category = "FRESHER";
  }

  return {
    fullName: fullName.trim() || "Attendee",
    phone: phone.trim() || "+91 0000000000",
    email: email.trim(),
    college: college.trim() || "Manipal School of Architecture & Planning",
    category: category,
    rollId: rollId.trim(),
    paymentUtr: utr.trim(),
    googleResponseId: responseId,
  };
}

/**
 * Optional: Writes the issued Ticket ID and Pass URL back to the Google Sheet row
 */
function writebackToSheet(e, data) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    const row = e.range.getRow();

    // Check if Ticket ID header exists or write to the next available columns
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let ticketCol = headers.indexOf("Assigned Ticket ID") + 1;
    let statusCol = headers.indexOf("Payment Status") + 1;

    if (ticketCol === 0) {
      ticketCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, ticketCol).setValue("Assigned Ticket ID");
    }
    if (statusCol === 0) {
      statusCol = ticketCol + 1;
      sheet.getRange(1, statusCol).setValue("Payment Status");
    }

    sheet.getRange(row, ticketCol).setValue(data.ticketId);
    sheet.getRange(row, statusCol).setValue(data.paymentStatus || "PENDING");
  } catch (err) {
    Logger.log("Writeback warning: " + err.toString());
  }
}

/**
 * Helper to test the connection directly from Apps Script Editor
 */
function testConnection() {
  const properties = PropertiesService.getScriptProperties();
  const backendUrl = properties.getProperty("BACKEND_URL") || CONFIG.DEFAULT_BACKEND_URL;
  const endpoint = backendUrl.replace(/\/+$/, "") + "/api/health";

  const response = UrlFetchApp.fetch(endpoint, { muteHttpExceptions: true });
  Logger.log("Health Check Status: " + response.getResponseCode());
  Logger.log("Health Check Body: " + response.getContentText());
}
