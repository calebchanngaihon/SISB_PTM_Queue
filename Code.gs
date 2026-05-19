/**
 * NEW HELPER: Prevents the "simultaneous invocations" crash
 * If multiple parents click at the exact same millisecond, this catches the error,
 * waits a fraction of a second, and tries again silently.
 */
function getSpreadsheetSafe() {
  for (let i = 0; i < 6; i++) {
    try {
      return SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      if (e.message.includes("simultaneous invocations") || e.message.includes("too many concurrent")) {
        Utilities.sleep(Math.random() * 1000 + 500); // Wait 0.5 to 1.5 seconds and try again
      } else {
        throw e; // If it's a different error, let it fail
      }
    }
  }
  throw new Error("The system is currently very busy. Please try again in a few seconds.");
}

/**
 * ROUTING
 */
function doGet(e) {
  var mode = e && e.parameter && e.parameter.mode;

  if (mode === 'teacher') return render('Teacher', 'Teacher Console - PTM');
  if (mode === 'display') return render('Display', 'Projector Display - PTM');
  if (mode === 'translator') return render('Translator', 'Translator Dash - PTM');
  if (mode === 'dashboard') return render('Dashboard', 'Dashboard - PTM');

  // Default is the Parent view
  return render('Parent', 'Parent Portal - PTM');
}

function render(file, pageTitle) {
  return HtmlService.createTemplateFromFile(file)
    .evaluate()
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle(pageTitle) // <--- This dynamically sets the browser tab name
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * CONFIG: Get Teacher List + Rooms, Subjects, and Departments
 */
function getTeacherList() {
  try {
    const ss = getSpreadsheetSafe();
    const tSheet = ss.getSheetByName("Teachers");
    const qSheet = ss.getSheetByName("Queue");
    
    if (!tSheet) return [{ name: "ERROR: Tab 'Teachers' missing", room: "", subject: "", department: "", count: 0 }];
    const lastRow = tSheet.getLastRow();
    if (lastRow < 2) return [{ name: "ERROR: No teachers found", room: "", subject: "", department: "", count: 0 }];
    
    const tData = tSheet.getRange(2, 1, lastRow - 1, 4).getValues();
    let qData = (qSheet && qSheet.getLastRow() > 1) ? qSheet.getDataRange().getValues() : [];
    
    return tData.filter(r => String(r[0]).trim() !== "").map(r => {
      const tName = String(r[0]).trim();
      const count = qData.filter(row => row[2] === tName && (row[3] === "Waiting" || row[3] === "Called")).length;
      return { 
        name: tName, 
        room: r[1] || "TBA", 
        subject: r[2] || "",          
        department: r[3] || "Other",  
        count: count 
      };
    });
  } catch (e) {
    return [{ name: "ERROR: " + e.message, room: "", subject: "", department: "", count: 0 }];
  }
}

/**
 * PARENT: Join queue(s) (With 9-column trackers)
 */
function joinQueue(studentName, className, selectedTeachers, translationRequests, parentId) {
  const ss = getSpreadsheetSafe();
  const sheet = ss.getSheetByName("Queue");
  if (!parentId) parentId = Utilities.getUuid();
  translationRequests = translationRequests || {};

  let nickname = studentName.includes(" (") ? studentName.substring(0, studentName.indexOf(" (")) : studentName;
  let classParts = className.split(" ");
  let shortClass = classParts.length > 1 ? classParts[0] + classParts[1].charAt(0).toUpperCase() : className;
  let formattedName = `${nickname} (${shortClass})`;

  const data = sheet.getDataRange().getValues();
  let childQueueCount = 0;
  let activeParentRows = [];

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId)) {
      if (!['Completed', 'Cancelled', 'Cancelling'].includes(data[i][3])) {
        activeParentRows.push({ rowIndex: i + 1, teacher: data[i][2], currentName: String(data[i][1]) });
        if (String(data[i][1]).includes(nickname)) childQueueCount++;
      }
    }
  }

  let newTeachersForChild = selectedTeachers.filter(t => {
    let existing = activeParentRows.find(r => r.teacher === t);
    return !(existing && existing.currentName.includes(nickname));
  });

  if (childQueueCount + newTeachersForChild.length > 3) {
    throw new Error(`Limit Reached: ${nickname} is already in 3 queues. Please complete a meeting before joining another.`);
  }

  selectedTeachers.forEach(teacher => {
    let requestedLang = translationRequests[teacher] || ""; 
    let existingQueue = activeParentRows.find(r => r.teacher === teacher);

    if (existingQueue) {
      if (!existingQueue.currentName.includes(nickname)) {
        sheet.getRange(existingQueue.rowIndex, 2).setValue(existingQueue.currentName + " & " + formattedName);
      }
      if (requestedLang) sheet.getRange(existingQueue.rowIndex, 10).setValue(requestedLang);
    } else {
      let newRow = Array(11).fill("");
      newRow[0] = parentId;
      newRow[1] = formattedName;
      newRow[2] = teacher;
      newRow[3] = "Waiting";
      newRow[4] = new Date();
      newRow[9] = requestedLang; 
      sheet.appendRow(newRow);
    }
  });
  return parentId;
}

/**
 * TEACHER: Granular Update
 */
function updateStatus(id, teacherName, action) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  const now = new Date();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id) && String(data[i][2]) === teacherName) {
      const row = i + 1;

      if (action === "call") {
        sheet.getRange(row, 3).setValue(teacherName);
        sheet.getRange(row, 4).setValue("Called");
        sheet.getRange(row, 6).setValue(now);
      } else if (action === "start") {
        sheet.getRange(row, 4).setValue("In-Meeting");
        sheet.getRange(row, 7).setValue(now);
        sheet.getRange(row, 11).setValue("CLAIMED");
      } else if (action === "finish") {
        sheet.getRange(row, 4).setValue("Completed");
        sheet.getRange(row, 8).setValue(now);
      } else if (action === "defer") {
        sheet.getRange(row, 4).setValue("Deferred");
      } else if (action === "dismiss") {
        sheet.getRange(row, 4).setValue("Completed");
        sheet.getRange(row, 9).setValue(now); 
      }
      return true;
    }
  }
}

/**
 * PARENT DASHBOARD
 */
function getParentDashboard(parentId) {
  const ss = getSpreadsheetSafe();
  const data = ss.getSheetByName("Queue").getDataRange().getValues();

  let teacherMap = {};
  try {
    const tSheet = ss.getSheetByName("Teachers");
    if(tSheet && tSheet.getLastRow() > 1){
      const teacherData = tSheet.getDataRange().getValues();
      for (let t = 1; t < teacherData.length; t++) {
        teacherMap[teacherData[t][0]] = {
          room: teacherData[t][1],
          subject: teacherData[t][2]
        };
      }
    }
  } catch (e) {
    console.log("Could not load Teachers sheet for rooms and subjects.");
  }

  let myQueues = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && !['Completed', 'Cancelled', 'Cancelling'].includes(data[i][3])) {
      let pos = 0;
      if (data[i][3] === 'Waiting') {
        for (let k = 1; k <= i; k++) {
          if (data[k][2] === data[i][2] && data[k][3] === 'Waiting') pos++;
        }
      }

      let teacherName = data[i][2];
      let tInfo = teacherMap[teacherName] || { room: "ROOM", subject: "" };

      myQueues.push({
        teacher: teacherName,
        name: data[i][1],
        status: data[i][3],
        position: pos || "-",
        room: tInfo.room || "ROOM",
        subject: tInfo.subject || ""
      });
    }
  }
  return myQueues;
}

/**
 * TEACHER VIEW
 */
function getTeacherView(teacherName) {
  const data = getSpreadsheetSafe().getSheetByName("Queue").getDataRange().getValues();

  let teacherBusy = data.some((r, i) => i > 0 && String(r[2]) === teacherName && (r[3] === "Called" || r[3] === "In-Meeting"));
  let busyParents = new Set(data.filter((r, i) => i > 0 && (r[3] === "Called" || r[3] === "In-Meeting")).map(r => String(r[0])));

  let queue = data.filter((r, i) => i > 0 && String(r[2]) === teacherName && !['Completed', 'Cancelled', 'Cancelling'].includes(r[3]))
    .sort((a, b) => new Date(a[4]) - new Date(b[4]))
    .map(r => ({
      id: r[0],
      name: r[1],
      status: r[3],
      isParentBusy: busyParents.has(String(r[0])) && (r[3] === "Waiting" || r[3] === "Deferred"),
      calledStart: r[5] ? new Date(r[5]).getTime() : "",
      meetingStart: r[6] ? new Date(r[6]).getTime() : "",
      language: r[9] || "",
      translatorName: r[10] || ""
    }));

  return { queue: queue, teacherBusy: teacherBusy };
}

/**
 * DISPLAY DATA (OPTIMIZED: Now includes the banner message!)
 */
function getDisplayData() {
  const ss = getSpreadsheetSafe();
  const qData = ss.getSheetByName("Queue").getDataRange().getValues();
  
  // Safely get room mappings
  let roomMap = {};
  const tSheet = ss.getSheetByName("Teachers");
  if (tSheet && tSheet.getLastRow() > 1) {
    const tData = tSheet.getRange(2, 1, tSheet.getLastRow() - 1, 2).getValues();
    tData.forEach(r => roomMap[r[0]] = r[1] || "---");
  }

  // Get the Banner Message in the same swoop
  const msgSheet = ss.getSheetByName("Message");
  const bannerMessage = msgSheet ? String(msgSheet.getRange("A1").getValue() || "") : "";

  let called = [], deferred = [], active = 0, done = 0;
  const now = new Date().getTime();
  
  for (let i = 1; i < qData.length; i++) {
    const s = qData[i][3];
    if (s === 'In-Meeting') active++;
    if (s === 'Completed') done++;
    if (s === 'Called') {
      called.push({ child: qData[i][1], teacher: qData[i][2], room: roomMap[qData[i][2]] || "TBA", time: new Date(qData[i][5]).getTime() });
    } else if (s === 'Deferred' && (now - new Date(qData[i][4]).getTime() < 2700000)) {
      deferred.push({ child: qData[i][1], teacher: qData[i][2] });
    }
  }
  
  return { 
    called: called.sort((a, b) => b.time - a.time), 
    deferred: deferred, 
    stats: { active: active, done: done },
    message: bannerMessage
  };
}

/**
 * CANCELLATIONS & COMPLETIONS
 */
function parentCancel(parentId, teacherName) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && String(data[i][2]) === String(teacherName)) {
      sheet.getRange(i + 1, 4).setValue('Cancelling');
      sheet.getRange(i + 1, 9).setValue(new Date());
      return true;
    }
  }
}

function cancelAllQueues(parentId) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && !['Completed', 'Cancelled', 'Cancelling'].includes(data[i][3])) {
      sheet.getRange(i + 1, 4).setValue('Cancelling');
      sheet.getRange(i + 1, 9).setValue(now);
    }
  }
  return true;
}

function parentComplete(parentId, teacherName) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && String(data[i][2]) === String(teacherName)) {
      sheet.getRange(i + 1, 4).setValue('Completed');
      sheet.getRange(i + 1, 8).setValue(new Date());
      return true;
    }
  }
}

function acknowledgeCancel(parentId, teacherName) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && String(data[i][2]) === String(teacherName)) {
      sheet.getRange(i + 1, 4).setValue('Cancelled');
      return true;
    }
  }
  return false;
}

/**
 * UTILS
 */
function getStudentData() {
  const sheet = getSpreadsheetSafe().getSheetByName("Students");
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  let classMap = {};
  for (let i = 1; i < data.length; i++) {
    let cls = String(data[i][2]).trim();
    if (!cls) continue;
    let name = (data[i][0] && data[i][0] !== data[i][1]) ? `${data[i][0]} (${data[i][1]})` : data[i][1];
    if (!classMap[cls]) classMap[cls] = [];
    classMap[cls].push(name);
  }
  for (let c in classMap) classMap[c].sort();
  return classMap;
}

function getTranslatorData() {
  const ss = getSpreadsheetSafe();
  const qData = ss.getSheetByName("Queue").getDataRange().getValues();

  let roomMap = {};
  const tSheet = ss.getSheetByName("Teachers");
  if (tSheet && tSheet.getLastRow() > 1) {
    const tData = tSheet.getRange(2, 1, tSheet.getLastRow() - 1, 2).getValues();
    tData.forEach(r => roomMap[r[0]] = r[1] || "---");
  }

  let jobs = [];
  for (let i = 1; i < qData.length; i++) {
    let status = qData[i][3]; 
    let lang = qData[i][9];   
    let claim = qData[i][10]; 

    if ((status === "Called" || status === "In-Meeting") && lang && !claim) {
      jobs.push({
        id: qData[i][0],
        teacher: qData[i][2],
        room: roomMap[qData[i][2]] || "TBA",
        language: lang,
        meetingStatus: status 
      });
    }
  }
  return jobs;
}

function claimTranslation(parentId, teacherName) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(parentId) && String(data[i][2]) === String(teacherName)) {
      sheet.getRange(i + 1, 11).setValue("CLAIMED"); 
      return true;
    }
  }
}

function requestTranslator(id, teacherName, language) {
  const sheet = getSpreadsheetSafe().getSheetByName("Queue");
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id) && String(data[i][2]) === String(teacherName)) {
      sheet.getRange(i + 1, 10).setValue(language); 
      sheet.getRange(i + 1, 11).setValue("");       
      return true;
    }
  }
}

function getMessages() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Message");
  
  // If the sheet doesn't exist yet, return safe defaults
  if (!sheet) {
    return { title: "Parent-Teacher Meeting", subtitle: "Select a child's class and name.", note: "Note: Maximum 3 teachers per child." };
  }
  
  return {
    title: sheet.getRange("A2").getDisplayValue(),
    subtitle: sheet.getRange("A3").getDisplayValue(),
    note: sheet.getRange("A4").getDisplayValue()
  };
}

/**
 * UPDATED: Optimized for the Leadership Dashboard
 * Uses the safe fetcher, handles "Q" or "Queue", and ensures dates are strings.
 */
function getQueueData() {
  const ss = getSpreadsheetSafe(); // Fix 1: Use the safe helper you built!
  
  // Fix 2: Check for 'Q' first, then 'Queue'
  let sheet = ss.getSheetByName('Queue'); 
  
  if (!sheet) {
    throw new Error("Could not find a tab named 'Q' or 'Queue'. Please check your sheet names.");
  }
  
  // Fix 3: Use getDisplayValues() to ensure dates are sent as strings
  const data = sheet.getDataRange().getDisplayValues(); 
  return data;
}