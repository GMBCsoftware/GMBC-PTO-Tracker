/*******************************
 * GMBC Paid Time Off App
 * Manual Anniversary Date Version
 *******************************/

const SHEETS = {
  EMPLOYEES: 'Employees',
  REQUESTS: 'Requests',
  SETTINGS: 'Settings',
  AUDIT: 'Audit'
};

const STATUS = {
  PENDING_SUPERVISOR: 'Pending Supervisor Approval',
  DENIED_SUPERVISOR: 'Denied by Supervisor',
  PENDING_ADMIN: 'Pending Admin Final Approval',
  DENIED_ADMIN: 'Denied by Admin',
  APPROVED: 'Approved'
};

const LEAVE_TYPES = {
  ANNUAL: 'Annual Leave',
  PERSONAL: 'Personal Leave',
  SERIOUS: 'Serious Illness Leave',
  BEREAVEMENT: 'Bereavement Leave',
  UNPAID: 'Unpaid Leave',
  OTHER: 'Other'
};

/*******************************
 * Web App
 *******************************/

function doGet(e) {
  const t = HtmlService.createTemplateFromFile('Index');
  return t.evaluate()
    .setTitle('GMBC Paid Time Off')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/*******************************
 * Main Data Load
 *******************************/

function getBootstrapData() {
  let user;

  try {
    user = getCurrentUser_();
  } catch (err) {
    audit_(
      'system',
      'Bootstrap failed',
      '',
      err && err.message
        ? err.message
        : 'Could not determine the current Google account.'
    );

    return makeClientSafe_({
      ok: false,
      message: err && err.message
        ? err.message
        : 'Could not determine your Google account.',
      user: {
        email: ''
      }
    });
  }

  const employee = getEmployeeByEmail_(user.email);

  if (!employee) {
    audit_(
      user.email || 'unknown',
      'Bootstrap rejected',
      '',
      'Email not listed in Employees sheet.'
    );

    return makeClientSafe_({
      ok: false,
      message: 'Your Google account was recognized, but your email is not listed in the PTO Employees sheet.',
      user: user
    });
  }

  if (!truthy_(employee.IsActive)) {
    audit_(
      user.email || 'unknown',
      'Bootstrap rejected',
      '',
      'Employee account is inactive.'
    );

    return makeClientSafe_({
      ok: false,
      message: 'Your PTO account is currently inactive.',
      user: user
    });
  }

  const isAdminUser = isAdmin_(employee.Email);
  const isSupervisorUser = isSupervisor_(employee.Email);

  const allRequestsRaw = getRequests_();

  const myRequests = allRequestsRaw.filter(function (r) {
    return lower_(r.EmployeeEmail) === lower_(employee.Email);
  });

  const supervisorRequests = allRequestsRaw.filter(function (r) {
    return lower_(r.SupervisorEmail) === lower_(employee.Email) &&
      r.Status === STATUS.PENDING_SUPERVISOR;
  });

  const allRequests = isAdminUser ? allRequestsRaw : [];

  const balances = calculateBalances_(employee, myRequests);

  return makeClientSafe_({
    ok: true,
    user: user,
    employee: employee,
    isAdmin: isAdminUser,
    isSupervisor: isSupervisorUser,
    balances: balances,
    myRequests: sortRequests_(myRequests),
    supervisorRequests: sortRequests_(supervisorRequests),
    allRequests: sortRequests_(allRequests)
  });
}

/*******************************
 * Request Submission
 *******************************/

function submitRequest(payload) {
  const user = getCurrentUser_();
  const employee = getEmployeeByEmail_(user.email);

  if (!employee) {
    throw new Error('Employee not found.');
  }

  const leaveType = String(payload.leaveType || '').trim();
  const startDate = String(payload.startDate || '').trim();
  const endDate = String(payload.endDate || '').trim();
  const hoursRequested = Number(payload.hoursRequested || 0);
  const reason = String(payload.reason || '').trim();

  if (!leaveType) {
    throw new Error('Please choose a leave type.');
  }

  if (!startDate || !endDate) {
    throw new Error('Please enter a start date and end date.');
  }

  if (!hoursRequested || hoursRequested <= 0) {
    throw new Error('Please enter the number of hours requested.');
  }

  if (new Date(endDate) < new Date(startDate)) {
    throw new Error('End date cannot be before start date.');
  }

  const existingEmployeeRequests = getRequests_().filter(function (r) {
    return lower_(r.EmployeeEmail) === lower_(employee.Email);
  });

  const warnings = validateRequest_(
    employee,
    leaveType,
    startDate,
    endDate,
    hoursRequested,
    existingEmployeeRequests,
    false
  );

  const request = {
    RequestId: Utilities.getUuid(),
    EmployeeEmail: employee.Email,
    EmployeeName: employee.Name,
    LeaveType: leaveType,
    StartDate: startDate,
    EndDate: endDate,
    HoursRequested: hoursRequested,
    Reason: reason,
    Status: STATUS.PENDING_SUPERVISOR,
    SupervisorEmail: employee.SupervisorEmail,
    SupervisorDecision: '',
    SupervisorDecisionDate: '',
    AdminDecision: '',
    AdminDecisionDate: '',
    CalendarEventId: '',
    Warnings: warnings.join(' | '),
    CreatedAt: now_(),
    UpdatedAt: now_()
  };

  appendObject_(SHEETS.REQUESTS, request);

  audit_(
    user.email,
    'Submitted PTO request',
    request.RequestId,
    JSON.stringify(request)
  );

  sendSupervisorEmail_(request);

  return {
    ok: true,
    message: warnings.length
      ? 'Request submitted with warning(s): ' + warnings.join(' ')
      : 'Request submitted for supervisor approval.'
  };
}

/*******************************
 * Supervisor Approval
 *******************************/

function supervisorDecision(requestId, decision, note, overrideBalance) {
  const user = getCurrentUser_();
  const request = getRequestById_(requestId);

  if (!request) {
    throw new Error('Request not found.');
  }

  const userIsAssignedSupervisor =
    lower_(request.SupervisorEmail) === lower_(user.email);

  if (!userIsAssignedSupervisor && !isAdmin_(user.email)) {
    throw new Error('Only the assigned supervisor or an admin can make this decision.');
  }

  if (request.Status !== STATUS.PENDING_SUPERVISOR) {
    throw new Error('This request is not waiting for supervisor approval.');
  }

  const approved = decision === 'approve';

  let warnings = String(request.Warnings || '');

  if (approved) {
    const employee = getEmployeeByEmail_(request.EmployeeEmail);
    const employeeRequests = getRequests_().filter(function (r) {
      return lower_(r.EmployeeEmail) === lower_(request.EmployeeEmail);
    });

    const warningArray = validateRequest_(
      employee,
      request.LeaveType,
      request.StartDate,
      request.EndDate,
      Number(request.HoursRequested),
      employeeRequests,
      Boolean(overrideBalance)
    );

    warnings = warningArray.join(' | ');
  }

  const updates = {
    SupervisorDecision: approved ? 'Approved' : 'Denied',
    SupervisorDecisionDate: now_(),
    Status: approved ? STATUS.PENDING_ADMIN : STATUS.DENIED_SUPERVISOR,
    Warnings: warnings,
    UpdatedAt: now_()
  };

  updateRequest_(requestId, updates);

  audit_(
    user.email,
    'Supervisor ' + updates.SupervisorDecision,
    requestId,
    JSON.stringify({
      note: note || '',
      overrideBalance: Boolean(overrideBalance),
      warnings: warnings
    })
  );

  const updatedRequest = Object.assign({}, request, updates);

  if (approved) {
    sendAdminFinalApprovalEmail_(updatedRequest);
  } else {
    sendEmployeeEmail_(
      request.EmployeeEmail,
      'Time off request denied by supervisor',
      'Your ' + request.LeaveType + ' request from ' + request.StartDate + ' to ' + request.EndDate +
      ' was denied by your supervisor.' +
      (note ? '\n\nNote: ' + note : '')
    );
  }

  return {
    ok: true,
    message: 'Supervisor decision saved.'
  };
}

/*******************************
 * Admin Final Approval
 *******************************/

function adminDecision(requestId, decision, note, overrideBalance) {
  const user = getCurrentUser_();

  if (!isAdmin_(user.email)) {
    throw new Error('Only admins can finalize PTO requests.');
  }

  const request = getRequestById_(requestId);

  if (!request) {
    throw new Error('Request not found.');
  }

  if (
    request.Status !== STATUS.PENDING_ADMIN &&
    request.Status !== STATUS.PENDING_SUPERVISOR
  ) {
    throw new Error('This request is not waiting for admin approval.');
  }

  const employee = getEmployeeByEmail_(request.EmployeeEmail);

  if (!employee) {
    throw new Error('Employee not found.');
  }

  const employeeRequests = getRequests_().filter(function (r) {
    return lower_(r.EmployeeEmail) === lower_(request.EmployeeEmail);
  });

  const warnings = validateRequest_(
    employee,
    request.LeaveType,
    request.StartDate,
    request.EndDate,
    Number(request.HoursRequested),
    employeeRequests,
    Boolean(overrideBalance)
  );

  const approved = decision === 'approve';

  let calendarEventId = '';

  if (approved) {
    calendarEventId = createCalendarEvent_(employee, request);
  }

  const updates = {
    AdminDecision: approved ? 'Approved' : 'Denied',
    AdminDecisionDate: now_(),
    Status: approved ? STATUS.APPROVED : STATUS.DENIED_ADMIN,
    CalendarEventId: calendarEventId,
    Warnings: warnings.join(' | '),
    UpdatedAt: now_()
  };

  updateRequest_(requestId, updates);

  audit_(
    user.email,
    'Admin ' + updates.AdminDecision,
    requestId,
    JSON.stringify({
      note: note || '',
      overrideBalance: Boolean(overrideBalance),
      warnings: warnings
    })
  );

  if (approved) {
    sendEmployeeEmail_(
      request.EmployeeEmail,
      'Time off request approved',
      'Your ' + request.LeaveType + ' request has received final approval.\n\n' +
      'Dates: ' + request.StartDate + ' to ' + request.EndDate + '\n' +
      'Hours: ' + request.HoursRequested + '\n\n' +
      (warnings.length ? 'Warning(s): ' + warnings.join(' ') : '')
    );
  } else {
    sendEmployeeEmail_(
      request.EmployeeEmail,
      'Time off request denied',
      'Your ' + request.LeaveType + ' request from ' + request.StartDate + ' to ' + request.EndDate +
      ' was denied by admin.' +
      (note ? '\n\nNote: ' + note : '')
    );
  }

  return {
    ok: true,
    message: 'Admin decision saved.'
  };
}
function updateRequestDetails(requestId, payload) {
  const user = getCurrentUser_();
  const request = getRequestById_(requestId);

  if (!request) {
    throw new Error('Request not found.');
  }

  const isAssignedSupervisor =
    lower_(request.SupervisorEmail) === lower_(user.email);

  const isAdminUser = isAdmin_(user.email);

  if (!isAssignedSupervisor && !isAdminUser) {
    throw new Error('Only the assigned supervisor or an admin can edit this request.');
  }

  if (
    request.Status !== STATUS.PENDING_SUPERVISOR &&
    request.Status !== STATUS.PENDING_ADMIN
  ) {
    throw new Error('Only pending requests can be edited.');
  }

  const employee = getEmployeeByEmail_(request.EmployeeEmail);

  if (!employee) {
    throw new Error('Employee not found.');
  }

  const startDate = String(payload.startDate || '').trim();
  const endDate = String(payload.endDate || '').trim();
  const hoursRequested = Number(payload.hoursRequested || 0);
  const reason = String(payload.reason || '').trim();

  if (!startDate || !endDate) {
    throw new Error('Start date and end date are required.');
  }

  if (!hoursRequested || hoursRequested <= 0) {
    throw new Error('Hours requested must be greater than 0.');
  }

  if (new Date(endDate) < new Date(startDate)) {
    throw new Error('End date cannot be before start date.');
  }

  const employeeRequests = getRequests_().filter(function (r) {
    return lower_(r.EmployeeEmail) === lower_(request.EmployeeEmail) &&
      String(r.RequestId) !== String(requestId);
  });

  const warnings = validateRequest_(
    employee,
    request.LeaveType,
    startDate,
    endDate,
    hoursRequested,
    employeeRequests,
    true
  );

  const updates = {
    StartDate: startDate,
    EndDate: endDate,
    HoursRequested: hoursRequested,
    Reason: reason,
    Warnings: warnings.join(' | '),
    UpdatedAt: now_()
  };

  updateRequest_(requestId, updates);

  audit_(
    user.email,
    'Edited PTO request details',
    requestId,
    JSON.stringify(updates)
  );

  return makeClientSafe_({
    ok: true,
    message: warnings.length
      ? 'Request updated with warning(s): ' + warnings.join(' ')
      : 'Request updated.'
  });
}

/*******************************
 * Balance + Policy Rules
 *******************************/

function calculateBalances_(employee, requests) {
  const annualAllowance = getAnnualLeaveAllowanceHours_(employee);
  const personalAllowance = getPersonalLeaveAllowanceHours_(employee);

  const approvedThisCycle = getApprovedRequestsInCurrentAnniversaryCycle_(
    employee,
    requests
  );

  const annualUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.ANNUAL);
  const personalUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.PERSONAL);
  const seriousUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.SERIOUS);
  const bereavementUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.BEREAVEMENT);
  const unpaidUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.UNPAID);
  const otherUsed = sumHours_(approvedThisCycle, LEAVE_TYPES.OTHER);

  return {
    annual: {
      label: LEAVE_TYPES.ANNUAL,
      allowanceHours: annualAllowance,
      usedHours: annualUsed,
      availableHours: annualAllowance - annualUsed
    },
    personal: {
      label: LEAVE_TYPES.PERSONAL,
      allowanceHours: personalAllowance,
      usedHours: personalUsed,
      availableHours: personalAllowance - personalUsed
    },
    serious: {
      label: LEAVE_TYPES.SERIOUS,
      allowanceHours: 'No cap',
      usedHours: seriousUsed,
      availableHours: 'No cap'
    },
    bereavement: {
      label: LEAVE_TYPES.BEREAVEMENT,
      allowanceHours: 'Manual review',
      usedHours: bereavementUsed,
      availableHours: 'Manual review'
    },
    unpaid: {
      label: LEAVE_TYPES.UNPAID,
      allowanceHours: 'Manual review',
      usedHours: unpaidUsed,
      availableHours: 'Manual review'
    },
    other: {
      label: LEAVE_TYPES.OTHER,
      allowanceHours: 'Manual review',
      usedHours: otherUsed,
      availableHours: 'Manual review'
    }
  };
}

function getAnnualLeaveAllowanceHours_(employee) {
  const years = getYearsOfService_(employee);

  // GMBC requested rule:
  // 0-2.99 years = 2 weeks / 10 workdays / 80 hours
  // 3-3.99 years = 3 weeks / 15 workdays / 120 hours
  // 4+ years = 4 weeks / 20 workdays / 160 hours max

  if (years < 3) {
    return 80;
  }

  if (years < 4) {
    return 120;
  }

  return 160;
}

function getPersonalLeaveAllowanceHours_(employee) {
  const years = getYearsOfService_(employee);
  const daysWorked = years * 365.25;

  // 6 days after 90 days.
  // 6 days x 8 hours = 48 hours.
  if (daysWorked < 90) {
    return 0;
  }

  return 48;
}

function validateRequest_(
  employee,
  leaveType,
  startDate,
  endDate,
  hoursRequested,
  requests,
  overrideBalance
) {
  const warnings = [];
  const balances = calculateBalances_(employee, requests);
  const start = new Date(startDate);
  const today = new Date();

  if (!getAnniversaryDate_(employee)) {
    warnings.push('No AnniversaryDate is listed for this employee. Balance may be inaccurate.');
  }

  if (leaveType === LEAVE_TYPES.ANNUAL) {
    const available = Number(balances.annual.availableHours);

    if (hoursRequested > available) {
      warnings.push(
        'This request exceeds available Annual Leave by ' +
        (hoursRequested - available) +
        ' hour(s).'
      );

      if (overrideBalance) {
        warnings.push(
          'Balance override allowed. This will create a negative Annual Leave balance until the next anniversary reset.'
        );
      } else {
        warnings.push(
          'Supervisor/Admin may override this later, but the request is currently over balance.'
        );
      }
    }

    if (hoursRequested > 40) {
      const daysNotice = Math.floor(
        (start.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysNotice < 30) {
        warnings.push(
          'Annual Leave over one week should be submitted at least 30 days in advance.'
        );
      }
    }
  }

  if (leaveType === LEAVE_TYPES.PERSONAL) {
    const available = Number(balances.personal.availableHours);

    if (hoursRequested > available) {
      warnings.push(
        'This request exceeds available Personal Leave by ' +
        (hoursRequested - available) +
        ' hour(s).'
      );

      if (overrideBalance) {
        warnings.push(
          'Balance override allowed. This will create a negative Personal Leave balance until the next anniversary reset.'
        );
      } else {
        warnings.push(
          'Supervisor/Admin may override this later, but the request is currently over balance.'
        );
      }
    }
  }

  if (leaveType === LEAVE_TYPES.SERIOUS) {
    warnings.push(
      'Serious Illness Leave has no cap, but should still be reviewed case-by-case.'
    );
  }

  if (truthy_(employee.IsPastoralStaff)) {
    warnings.push(
      'Pastoral staff leave should be coordinated so pastoral coverage remains available.'
    );
  }

  return warnings;
}

/*******************************
 * Anniversary / Service Date
 *******************************/

function getAnniversaryDate_(employee) {
  // Manual source of truth.
  // Employees sheet column must be named AnniversaryDate.
  return normalizeDateString_(employee.AnniversaryDate);
}

function getYearsOfService_(employee) {
  const anniversaryDate = getAnniversaryDate_(employee);

  if (!anniversaryDate) {
    return 0;
  }

  const start = new Date(anniversaryDate);
  const today = new Date();

  if (isNaN(start.getTime())) {
    return 0;
  }

  return Math.max(
    0,
    (today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25)
  );
}

function getCurrentAnniversaryStart_(employee) {
  const anniversaryDate = getAnniversaryDate_(employee);

  if (!anniversaryDate) {
    return new Date('1900-01-01T00:00:00');
  }

  const original = new Date(anniversaryDate);
  const today = new Date();

  if (isNaN(original.getTime())) {
    return new Date('1900-01-01T00:00:00');
  }

  let cycleStart = new Date(
    today.getFullYear(),
    original.getMonth(),
    original.getDate()
  );

  if (cycleStart > today) {
    cycleStart = new Date(
      today.getFullYear() - 1,
      original.getMonth(),
      original.getDate()
    );
  }

  return cycleStart;
}

function getApprovedRequestsInCurrentAnniversaryCycle_(employee, requests) {
  const cycleStart = getCurrentAnniversaryStart_(employee);

  return requests.filter(function (r) {
    if (r.Status !== STATUS.APPROVED) {
      return false;
    }

    const requestStart = new Date(r.StartDate);

    if (isNaN(requestStart.getTime())) {
      return false;
    }

    return requestStart >= cycleStart;
  });
}

/**
 * Optional daily trigger.
 * Since balances are calculated dynamically by anniversary cycle,
 * this does not need to rewrite balances.
 * It simply logs anniversary refreshes.
 */
function dailyAnniversaryRefresh() {
  const employees = getEmployees_().filter(function (e) {
    return truthy_(e.IsActive);
  });

  const today = new Date();

  employees.forEach(function (employee) {
    const anniversaryDate = getAnniversaryDate_(employee);

    if (!anniversaryDate) {
      return;
    }

    const anniversary = new Date(anniversaryDate);

    if (isNaN(anniversary.getTime())) {
      return;
    }

    const sameMonth = anniversary.getMonth() === today.getMonth();
    const sameDay = anniversary.getDate() === today.getDate();

    if (sameMonth && sameDay) {
      audit_(
        'system',
        'Anniversary refresh',
        '',
        employee.Email + ' reached anniversary date. Balances reset dynamically by current anniversary cycle.'
      );
    }
  });
}

/*******************************
 * Calendar
 *******************************/

function createCalendarEvent_(employee, request) {
  const settings = getSettings_();

  const employeeCalendarId = String(employee.CalendarId || '').trim();
  const settingsCalendarId = String(settings.PtoCalendarId || '').trim();

  const calendarId = employeeCalendarId || settingsCalendarId || 'primary';

  const calendar = CalendarApp.getCalendarById(calendarId);

  if (!calendar) {
    throw new Error('Could not find PTO calendar: ' + calendarId);
  }

  const start = parseLocalDate_(request.StartDate);
  const listedEnd = parseLocalDate_(request.EndDate);

  // Google Calendar all-day multi-day events use an exclusive end date.
  const end = addDays_(listedEnd, 1);

  if (start >= end) {
    throw new Error(
      'Event start date must be before event end date. Start: ' +
      start +
      ' End: ' +
      end
    );
  }

  // Do not expose the leave type on the calendar.
  const title = request.EmployeeName + ' - PTO';

  const description =
    'Approved staff time off\n\n' +
    'Employee: ' + request.EmployeeName + '\n' +
    'Request ID: ' + request.RequestId;

  const event = calendar.createAllDayEvent(title, start, end, {
    description: description
  });

  return event.getId();
}

/*******************************
 * Email
 *******************************/

function sendSupervisorEmail_(request) {
  if (!request.SupervisorEmail) {
    audit_(
      'system',
      'Missing supervisor email',
      request.RequestId,
      'No supervisor email listed for ' + request.EmployeeEmail
    );
    return;
  }

  const subject = 'PTO request needs your approval - ' + request.EmployeeName;

  const body =
    request.EmployeeName + ' submitted a ' + request.LeaveType + ' request.\n\n' +
    'Dates: ' + request.StartDate + ' to ' + request.EndDate + '\n' +
    'Hours: ' + request.HoursRequested + '\n' +
    'Reason: ' + (request.Reason || '') + '\n\n' +
    'Please open the PTO app to approve or deny this request.\n\n' +
    'Request ID:\n' + request.RequestId;

  GmailApp.sendEmail(request.SupervisorEmail, subject, body);
}

function sendAdminFinalApprovalEmail_(request) {
  const settings = getSettings_();
  const admins = String(settings.AdminEmails || '')
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);

  if (!admins.length) {
    audit_(
      'system',
      'No admin emails configured',
      request.RequestId,
      'Settings.AdminEmails is blank.'
    );
    return;
  }

  const subject = 'PTO request ready for final approval - ' + request.EmployeeName;

  const body =
    request.EmployeeName + '\'s ' + request.LeaveType + ' request was approved by their supervisor and is ready for final admin approval.\n\n' +
    'Dates: ' + request.StartDate + ' to ' + request.EndDate + '\n' +
    'Hours: ' + request.HoursRequested + '\n' +
    'Warnings: ' + (request.Warnings || 'None') + '\n\n' +
    'Please open the PTO app to give final approval or denial.\n\n' +
    'Request ID:\n' + request.RequestId;

  GmailApp.sendEmail(admins.join(','), subject, body);
}

function sendEmployeeEmail_(to, subject, body) {
  GmailApp.sendEmail(to, subject, body);
}

/*******************************
 * Data Access
 *******************************/

function getCurrentUser_() {
  const email = Session.getActiveUser().getEmail();

  if (!email) {
    throw new Error(
      'Could not determine your Google Workspace email. Try opening the app from the correct Workspace account, then confirm the web app is deployed to run as the script owner and shared to your domain.'
    );
  }

  return {
    email: email
  };
}

function getEmployees_() {
  return getSheetObjects_(SHEETS.EMPLOYEES);
}

function getRequests_() {
  return getSheetObjects_(SHEETS.REQUESTS);
}

function getSettings_() {
  const rows = getSheetObjects_(SHEETS.SETTINGS);
  const obj = {};

  rows.forEach(function (r) {
    obj[String(r.Key)] = r.Value;
  });

  return obj;
}

function getEmployeeByEmail_(email) {
  return getEmployees_().find(function (e) {
    return lower_(e.Email) === lower_(email);
  });
}

function getRequestById_(requestId) {
  return getRequests_().find(function (r) {
    return String(r.RequestId) === String(requestId);
  });
}

function isAdmin_(email) {
  const employee = getEmployeeByEmail_(email);

  if (employee && truthy_(employee.IsAdmin)) {
    return true;
  }

  const settings = getSettings_();

  return String(settings.AdminEmails || '')
    .split(',')
    .map(function (s) {
      return lower_(s.trim());
    })
    .includes(lower_(email));
}

function isSupervisor_(email) {
  const employee = getEmployeeByEmail_(email);

  if (employee && truthy_(employee.IsSupervisor)) {
    return true;
  }

  const hasDirectReports = getEmployees_().some(function (e) {
    return lower_(e.SupervisorEmail) === lower_(email);
  });

  return hasDirectReports;
}

function getSheetObjects_(sheetName) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);

  if (!sh) {
    throw new Error('Missing sheet: ' + sheetName);
  }

  const values = sh.getDataRange().getValues();

  if (values.length < 2) {
    return [];
  }

  const headers = values[0].map(function (h) {
    return String(h).trim();
  });

  return values.slice(1)
    .filter(function (row) {
      return row.some(function (cell) {
        return cell !== '';
      });
    })
    .map(function (row) {
      const obj = {};

      headers.forEach(function (h, i) {
        obj[h] = row[i];
      });

      return obj;
    });
}

function appendObject_(sheetName, obj) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);

  if (!sh) {
    throw new Error('Missing sheet: ' + sheetName);
  }

  const headers = sh
    .getRange(1, 1, 1, sh.getLastColumn())
    .getValues()[0]
    .map(function (h) {
      return String(h).trim();
    });

  const row = headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  });

  sh.appendRow(row);
}

function updateRequest_(requestId, updates) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.REQUESTS);

  if (!sh) {
    throw new Error('Missing sheet: ' + SHEETS.REQUESTS);
  }

  const values = sh.getDataRange().getValues();
  const headers = values[0].map(function (h) {
    return String(h).trim();
  });

  const idCol = headers.indexOf('RequestId');

  if (idCol < 0) {
    throw new Error('Requests sheet is missing RequestId column.');
  }

  for (let r = 1; r < values.length; r++) {
    if (String(values[r][idCol]) === String(requestId)) {
      Object.keys(updates).forEach(function (key) {
        const c = headers.indexOf(key);

        if (c >= 0) {
          sh.getRange(r + 1, c + 1).setValue(updates[key]);
        }
      });

      return;
    }
  }

  throw new Error('Request not found for update.');
}

function audit_(actor, action, requestId, details) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEETS.AUDIT);

  if (!sh) {
    return;
  }

  sh.appendRow([
    now_(),
    actor,
    action,
    requestId,
    details
  ]);
}

/*******************************
 * Utility
 *******************************/

function sumHours_(requests, leaveType) {
  return requests
    .filter(function (r) {
      return r.LeaveType === leaveType;
    })
    .reduce(function (sum, r) {
      return sum + Number(r.HoursRequested || 0);
    }, 0);
}

function sortRequests_(requests) {
  return requests.sort(function (a, b) {
    const aDate = a.CreatedAt ? new Date(a.CreatedAt).getTime() : 0;
    const bDate = b.CreatedAt ? new Date(b.CreatedAt).getTime() : 0;
    return bDate - aDate;
  });
}

function now_() {
  return new Date();
}

function lower_(v) {
  return String(v || '').trim().toLowerCase();
}

function truthy_(v) {
  return String(v).toLowerCase() === 'true' ||
    v === true ||
    v === 1;
}

function normalizeDateString_(value) {
  if (!value) {
    return '';
  }

  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
  }

  return String(value).trim();
}

function parseLocalDate_(value) {
  if (!value) {
    throw new Error('Missing date value.');
  }

  // If Google Sheets gave us an actual Date object
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return new Date(
      value.getFullYear(),
      value.getMonth(),
      value.getDate()
    );
  }

  // If we have a yyyy-mm-dd string
  const text = String(value).trim();
  const parts = text.substring(0, 10).split('-');

  if (parts.length === 3) {
    return new Date(
      Number(parts[0]),
      Number(parts[1]) - 1,
      Number(parts[2])
    );
  }

  const parsed = new Date(text);

  if (isNaN(parsed.getTime())) {
    throw new Error('Invalid date value: ' + text);
  }

  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate()
  );
}

function addDays_(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function makeClientSafe_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
  }

  if (Array.isArray(value)) {
    return value.map(makeClientSafe_);
  }

  if (value && typeof value === 'object') {
    const safe = {};
    Object.keys(value).forEach(function (key) {
      safe[key] = makeClientSafe_(value[key]);
    });
    return safe;
  }

  return value;
}
