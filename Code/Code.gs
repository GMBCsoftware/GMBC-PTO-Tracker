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
  PENDING_SUPERVISOR_EDIT: 'Pending Supervisor Reapproval',
  DENIED_SUPERVISOR: 'Denied by Supervisor',
  DENIED_SUPERVISOR_EDIT: 'Edit Denied by Supervisor',
  PENDING_ADMIN: 'Pending Admin Final Approval',
  PENDING_ADMIN_EDIT: 'Pending Admin Reapproval',
  DENIED_ADMIN: 'Denied by Admin',
  DENIED_ADMIN_EDIT: 'Edit Denied by Admin',
  APPROVED: 'Approved',
  APPROVED_EDIT: 'Edit Approved'
};

const REQUEST_METADATA_COLUMNS = [
  'ChangeType',
  'OriginalRequestId',
  'PreviousVersionJson'
];

const LEAVE_TYPES = {
  ANNUAL: 'Annual Leave',
  PERSONAL: 'Personal Leave',
  SERIOUS: 'Serious Illness Leave',
  BEREAVEMENT: 'Bereavement Leave',
  UNPAID: 'Unpaid Leave',
  OTHER: 'Other'
};

// Optional override for the PTO web app link used in email buttons.
// Leave blank to fall back to the deployed Script URL automatically.
const PTO_EMAIL_BUTTON_URL = '';

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
  ensureRequestSheetColumns_();
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
      webAppUrl: getWebAppUrl_(),
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
      webAppUrl: getWebAppUrl_(),
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
      webAppUrl: getWebAppUrl_(),
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
    return lower_(r.SupervisorEmail) === lower_(employee.Email);
  });

  const allRequests = isAdminUser ? allRequestsRaw : [];

  const balances = calculateBalances_(employee, myRequests);
  const visibleMyRequests = getRequestsVisibleInCurrentAnniversaryCycle_(employee, myRequests);

  return makeClientSafe_({
    ok: true,
    user: user,
    webAppUrl: getWebAppUrl_(),
    employee: employee,
    recommendedSchedule: getEmployeeScheduleConfig_(employee),
    isAdmin: isAdminUser,
    isSupervisor: isSupervisorUser,
    balances: balances,
    myRequests: sortRequests_(visibleMyRequests),
    supervisorRequests: sortRequests_(supervisorRequests),
    allRequests: sortRequests_(allRequests)
  });
}

function getWebAppUrl_() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (err) {
    return '';
  }
}

/*******************************
 * Request Submission
 *******************************/

function submitRequest(payload) {
  ensureRequestSheetColumns_();
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
    ChangeType: '',
    OriginalRequestId: '',
    PreviousVersionJson: '',
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
  ensureRequestSheetColumns_();
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

  if (
    request.Status !== STATUS.PENDING_SUPERVISOR &&
    request.Status !== STATUS.PENDING_SUPERVISOR_EDIT
  ) {
    throw new Error('This request is not waiting for supervisor approval.');
  }

  const approved = decision === 'approve';
  const isEditRequest = isEditRequest_(request);

  let warnings = String(request.Warnings || '');

  if (approved) {
    const employee = getEmployeeByEmail_(request.EmployeeEmail);
    const employeeRequests = getRequests_().filter(function (r) {
      if (lower_(r.EmployeeEmail) !== lower_(request.EmployeeEmail)) {
        return false;
      }

      if (String(r.RequestId) === String(requestId)) {
        return false;
      }

      if (
        isEditRequest &&
        String(r.RequestId) === String(request.OriginalRequestId)
      ) {
        return false;
      }

      return true;
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
    Status: approved
      ? (isEditRequest ? STATUS.PENDING_ADMIN_EDIT : STATUS.PENDING_ADMIN)
      : (isEditRequest ? STATUS.DENIED_SUPERVISOR_EDIT : STATUS.DENIED_SUPERVISOR),
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
      isEditRequest
        ? 'Time off request change denied by supervisor'
        : 'Time off request denied by supervisor',
      'Your ' + request.LeaveType + ' request from ' + request.StartDate + ' to ' + request.EndDate +
      (isEditRequest
        ? ' change was denied by your supervisor. Your previously approved schedule remains unchanged.'
        : ' was denied by your supervisor.') +
      (note ? '\n\nNote: ' + note : ''),
      {
        eyebrow: 'Supervisor Decision',
        title: isEditRequest
          ? 'Time Off Change Denied'
          : 'Time Off Request Denied',
        intro: 'Your <strong>' + escapeHtml_(request.LeaveType) + '</strong> request was denied by your supervisor.',
        details: [
          ['Leave type', request.LeaveType],
          ['Dates', formatPtoDateRange_(request.StartDate, request.EndDate)],
          ['Hours requested', request.HoursRequested],
          ['Note', note || 'No note provided']
        ],
        warning: isEditRequest
          ? 'Your previously approved calendar schedule remains unchanged.'
          : '',
        notice: 'Open the PTO app if you need to review or submit another request.',
        requestId: request.RequestId
      }
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
  ensureRequestSheetColumns_();
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
    request.Status !== STATUS.PENDING_SUPERVISOR &&
    request.Status !== STATUS.PENDING_ADMIN_EDIT &&
    request.Status !== STATUS.PENDING_SUPERVISOR_EDIT
  ) {
    throw new Error('This request is not waiting for admin approval.');
  }

  const employee = getEmployeeByEmail_(request.EmployeeEmail);
  const isEditRequest = isEditRequest_(request);

  if (!employee) {
    throw new Error('Employee not found.');
  }

  const employeeRequests = getRequests_().filter(function (r) {
    if (lower_(r.EmployeeEmail) !== lower_(request.EmployeeEmail)) {
      return false;
    }

    if (String(r.RequestId) === String(requestId)) {
      return false;
    }

    if (
      isEditRequest &&
      String(r.RequestId) === String(request.OriginalRequestId)
    ) {
      return false;
    }

    return true;
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
    if (isEditRequest) {
      calendarEventId = applyApprovedEditRequest_(request, employee, warnings);
    } else {
      calendarEventId = createCalendarEvent_(employee, request);
    }
  }

  const updates = {
    AdminDecision: approved ? 'Approved' : 'Denied',
    AdminDecisionDate: now_(),
    Status: approved
      ? (isEditRequest ? STATUS.APPROVED_EDIT : STATUS.APPROVED)
      : (isEditRequest ? STATUS.DENIED_ADMIN_EDIT : STATUS.DENIED_ADMIN),
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
      isEditRequest
        ? 'Time off request change approved'
        : 'Time off request approved',
      'Your ' + request.LeaveType + ' request has received final approval.\n\n' +
      'Dates: ' + request.StartDate + ' to ' + request.EndDate + '\n' +
      'Hours: ' + request.HoursRequested + '\n\n' +
      (warnings.length ? 'Warning(s): ' + warnings.join(' ') : ''),
      {
        eyebrow: 'Final Approval',
        title: isEditRequest
          ? 'Time Off Change Approved'
          : 'Time Off Request Approved',
        intro: 'Your <strong>' + escapeHtml_(request.LeaveType) + '</strong> request has received final approval.',
        details: [
          ['Leave type', request.LeaveType],
          ['Dates', formatPtoDateRange_(request.StartDate, request.EndDate)],
          ['Hours requested', request.HoursRequested],
          ['Warnings', warnings.length ? warnings.join(' ') : 'None']
        ],
        notice: 'Open the PTO app any time to review your request history.',
        requestId: request.RequestId
      }
    );
  } else {
    sendEmployeeEmail_(
      request.EmployeeEmail,
      isEditRequest
        ? 'Time off request change denied'
        : 'Time off request denied',
      'Your ' + request.LeaveType + ' request from ' + request.StartDate + ' to ' + request.EndDate +
      (isEditRequest
        ? ' change was denied by admin. Your previously approved schedule remains unchanged.'
        : ' was denied by admin.') +
      (note ? '\n\nNote: ' + note : ''),
      {
        eyebrow: 'Admin Decision',
        title: isEditRequest
          ? 'Time Off Change Denied'
          : 'Time Off Request Denied',
        intro: 'Your <strong>' + escapeHtml_(request.LeaveType) + '</strong> request was denied by admin.',
        details: [
          ['Leave type', request.LeaveType],
          ['Dates', formatPtoDateRange_(request.StartDate, request.EndDate)],
          ['Hours requested', request.HoursRequested],
          ['Note', note || 'No note provided']
        ],
        warning: isEditRequest
          ? 'Your previously approved calendar schedule remains unchanged.'
          : '',
        notice: 'Open the PTO app if you need to review or submit another request.',
        requestId: request.RequestId
      }
    );
  }

  return {
    ok: true,
    message: 'Admin decision saved.'
  };
}
function updateRequestDetails(requestId, payload) {
  ensureRequestSheetColumns_();
  const user = getCurrentUser_();
  const request = getRequestById_(requestId);

  if (!request) {
    throw new Error('Request not found.');
  }

  const isEmployeeOwner = lower_(request.EmployeeEmail) === lower_(user.email);
  const isAssignedSupervisor =
    lower_(request.SupervisorEmail) === lower_(user.email);
  const isAdminUser = isAdmin_(user.email);

  if (!isEmployeeOwner && !isAssignedSupervisor && !isAdminUser) {
    throw new Error('Only the employee, assigned supervisor, or an admin can edit this request.');
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
    if (lower_(r.EmployeeEmail) !== lower_(request.EmployeeEmail)) {
      return false;
    }

    if (String(r.RequestId) === String(requestId)) {
      return false;
    }

    if (
      isEditRequest_(request) &&
      String(r.RequestId) === String(request.OriginalRequestId)
    ) {
      return false;
    }

    return true;
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

  if (
    isEmployeeOwner &&
    request.Status === STATUS.APPROVED &&
    !isEditRequest_(request)
  ) {
    return createApprovedRequestEdit_(request, employee, {
      startDate: startDate,
      endDate: endDate,
      hoursRequested: hoursRequested,
      reason: reason,
      warnings: warnings
    });
  }

  if (
    request.Status !== STATUS.PENDING_SUPERVISOR &&
    request.Status !== STATUS.PENDING_ADMIN &&
    request.Status !== STATUS.PENDING_SUPERVISOR_EDIT &&
    request.Status !== STATUS.PENDING_ADMIN_EDIT
  ) {
    throw new Error('This request cannot be edited in its current status.');
  }

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

function createApprovedRequestEdit_(request, employee, payload) {
  const pendingEdit = getRequests_().find(function (row) {
    return isEditRequest_(row) &&
      String(row.OriginalRequestId) === String(request.RequestId) &&
      (
        row.Status === STATUS.PENDING_SUPERVISOR_EDIT ||
        row.Status === STATUS.PENDING_ADMIN_EDIT
      );
  });

  if (pendingEdit) {
    throw new Error('There is already a pending schedule change for this approved request.');
  }

  const editRequest = {
    RequestId: Utilities.getUuid(),
    EmployeeEmail: request.EmployeeEmail,
    EmployeeName: request.EmployeeName,
    LeaveType: request.LeaveType,
    StartDate: payload.startDate,
    EndDate: payload.endDate,
    HoursRequested: payload.hoursRequested,
    Reason: payload.reason,
    Status: STATUS.PENDING_SUPERVISOR_EDIT,
    SupervisorEmail: request.SupervisorEmail || employee.SupervisorEmail,
    SupervisorDecision: '',
    SupervisorDecisionDate: '',
    AdminDecision: '',
    AdminDecisionDate: '',
    CalendarEventId: '',
    Warnings: payload.warnings.join(' | '),
    ChangeType: 'edit',
    OriginalRequestId: request.RequestId,
    PreviousVersionJson: JSON.stringify({
      StartDate: request.StartDate,
      EndDate: request.EndDate,
      HoursRequested: request.HoursRequested,
      Reason: request.Reason,
      CalendarEventId: request.CalendarEventId
    }),
    CreatedAt: now_(),
    UpdatedAt: now_()
  };

  appendObject_(SHEETS.REQUESTS, editRequest);

  audit_(
    request.EmployeeEmail,
    'Submitted approved PTO request change',
    editRequest.RequestId,
    JSON.stringify(editRequest)
  );

  sendEditApprovalRequestEmails_(editRequest);

  return makeClientSafe_({
    ok: true,
    message: payload.warnings.length
      ? 'Updated schedule submitted for reapproval with warning(s): ' + payload.warnings.join(' ')
      : 'Updated schedule submitted for reapproval.'
  });
}

/*******************************
 * Balance + Policy Rules
 *******************************/

function calculateBalances_(employee, requests) {
  const annualAllowance = getAnnualLeaveAllowanceHours_(employee);
  const personalAllowance = getPersonalLeaveAllowanceHours_(employee);
  const seriousAllowance = getSeriousLeaveAllowanceHours_(employee);
  const activeRequests = getCanonicalBalanceRequests_(requests);

  const approvedStartedThisCycle = getApprovedRequestsInCurrentAnniversaryCycle_(
    employee,
    activeRequests
  );

  const requestedUpcomingThisCycle = getUpcomingRequestedRequestsInCurrentAnniversaryCycle_(
    employee,
    activeRequests
  );

  const annualUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.ANNUAL);
  const personalUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.PERSONAL);
  const seriousUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.SERIOUS);
  const bereavementUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.BEREAVEMENT);
  const unpaidUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.UNPAID);
  const otherUsed = sumHours_(approvedStartedThisCycle, LEAVE_TYPES.OTHER);

  const annualRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.ANNUAL);
  const personalRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.PERSONAL);
  const seriousRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.SERIOUS);
  const bereavementRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.BEREAVEMENT);
  const unpaidRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.UNPAID);
  const otherRequested = sumHours_(requestedUpcomingThisCycle, LEAVE_TYPES.OTHER);

  return {
    annual: {
      label: LEAVE_TYPES.ANNUAL,
      allowanceHours: annualAllowance,
      usedHours: annualUsed,
      requestedHours: annualRequested,
      availableHours: annualAllowance - annualUsed,
      remainingAfterRequestedHours: annualAllowance - annualUsed - annualRequested
    },
    personal: {
      label: LEAVE_TYPES.PERSONAL,
      allowanceHours: personalAllowance,
      usedHours: personalUsed,
      requestedHours: personalRequested,
      availableHours: personalAllowance - personalUsed,
      remainingAfterRequestedHours: personalAllowance - personalUsed - personalRequested
    },
    serious: {
      label: LEAVE_TYPES.SERIOUS,
      allowanceHours: seriousAllowance,
      usedHours: seriousUsed,
      requestedHours: seriousRequested,
      availableHours: seriousAllowance - seriousUsed,
      remainingAfterRequestedHours: seriousAllowance - seriousUsed - seriousRequested
    },
    bereavement: {
      label: LEAVE_TYPES.BEREAVEMENT,
      allowanceHours: 'Manual review',
      usedHours: bereavementUsed,
      requestedHours: bereavementRequested,
      availableHours: 'Manual review',
      remainingAfterRequestedHours: 'Manual review'
    },
    unpaid: {
      label: LEAVE_TYPES.UNPAID,
      allowanceHours: 'Manual review',
      usedHours: unpaidUsed,
      requestedHours: unpaidRequested,
      availableHours: 'Manual review',
      remainingAfterRequestedHours: 'Manual review'
    },
    other: {
      label: LEAVE_TYPES.OTHER,
      allowanceHours: 'Manual review',
      usedHours: otherUsed,
      requestedHours: otherRequested,
      availableHours: 'Manual review',
      remainingAfterRequestedHours: 'Manual review'
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

function getSeriousLeaveAllowanceHours_(employee) {
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
    const available = Number(balances.annual.remainingAfterRequestedHours);

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
    const available = Number(balances.personal.remainingAfterRequestedHours);

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
    const available = Number(balances.serious.remainingAfterRequestedHours);

    if (hoursRequested > available) {
      warnings.push(
        'This request exceeds available Serious Illness Leave by ' +
        (hoursRequested - available) +
        ' hour(s).'
      );

      if (overrideBalance) {
        warnings.push(
          'Balance override allowed. This will create a negative Serious Illness Leave balance until the next anniversary reset.'
        );
      } else {
        warnings.push(
          'Supervisor/Admin may override this later, but the request is currently over balance.'
        );
      }
    }
  }

  if (truthy_(employee.IsPastoralStaff)) {
    warnings.push(
      'Pastoral staff leave should be coordinated so pastoral coverage remains available.'
    );
  }

  return warnings;
}

function getEmployeeScheduleConfig_(employee) {
  const settings = getSettings_();
  const employmentType = String(employee.EmploymentType || '').trim();
  const configuredPattern = employmentType && settings[employmentType]
    ? String(settings[employmentType]).trim()
    : '';
  const fallbackPattern = String(settings['Full-Time'] || '').trim();
  const schedulePattern = configuredPattern || fallbackPattern || 'SUN-THUR';

  return parseWorkSchedulePattern_(schedulePattern, employmentType || 'Default');
}

function parseWorkSchedulePattern_(pattern, label) {
  const normalizedPattern = String(pattern || '').trim().toUpperCase();
  const dayTokens = ['SUN', 'MON', 'TUE', 'WED', 'THUR', 'FRI', 'SAT'];
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday'
  ];
  const indexesByToken = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THUR: 4,
    THU: 4,
    FRI: 5,
    SAT: 6
  };
  const workingDayIndexes = [];
  const parts = normalizedPattern
    ? normalizedPattern.split(',').map(function (part) {
      return part.trim();
    }).filter(Boolean)
    : [];

  if (!parts.length) {
    return {
      label: label,
      pattern: 'SUN-THUR',
      workingDayIndexes: [0, 1, 2, 3, 4],
      workingDayNames: dayNames.slice(0, 5)
    };
  }

  parts.forEach(function (part) {
    if (part.indexOf('-') >= 0) {
      const rangeParts = part.split('-').map(function (piece) {
        return piece.trim();
      });
      const startIndex = indexesByToken[rangeParts[0]];
      const endIndex = indexesByToken[rangeParts[1]];

      if (startIndex === undefined || endIndex === undefined) {
        return;
      }

      let cursor = startIndex;

      while (workingDayIndexes.indexOf(cursor) < 0) {
        workingDayIndexes.push(cursor);

        if (cursor === endIndex) {
          break;
        }

        cursor = (cursor + 1) % dayTokens.length;
      }

      return;
    }

    if (indexesByToken[part] !== undefined && workingDayIndexes.indexOf(indexesByToken[part]) < 0) {
      workingDayIndexes.push(indexesByToken[part]);
    }
  });

  const normalizedIndexes = workingDayIndexes.slice().sort(function (a, b) {
    return a - b;
  });

  if (!normalizedIndexes.length) {
    return {
      label: label,
      pattern: 'SUN-THUR',
      workingDayIndexes: [0, 1, 2, 3, 4],
      workingDayNames: dayNames.slice(0, 5)
    };
  }

  return {
    label: label,
    pattern: normalizedPattern || 'SUN-THUR',
    workingDayIndexes: normalizedIndexes,
    workingDayNames: normalizedIndexes.map(function (index) {
      return dayNames[index];
    })
  };
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
  const today = startOfToday_();

  return requests.filter(function (r) {
    if (!isApprovedBalanceStatus_(r.Status)) {
      return false;
    }

    const requestStart = new Date(r.StartDate);

    if (isNaN(requestStart.getTime())) {
      return false;
    }

    return requestStart >= cycleStart && requestStart <= today;
  });
}

function getUpcomingRequestedRequestsInCurrentAnniversaryCycle_(employee, requests) {
  const cycleStart = getCurrentAnniversaryStart_(employee);
  const today = startOfToday_();

  return requests.filter(function (r) {
    const requestStart = new Date(r.StartDate);

    if (isNaN(requestStart.getTime())) {
      return false;
    }

    if (requestStart < cycleStart || requestStart <= today) {
      return false;
    }

    return isPendingBalanceStatus_(r.Status) || isApprovedBalanceStatus_(r.Status);
  });
}

function getCanonicalBalanceRequests_(requests) {
  return requests.filter(function (request) {
    return !isEditRequest_(request) && !isDeniedBalanceStatus_(request.Status);
  });
}

function getRequestsVisibleInCurrentAnniversaryCycle_(employee, requests) {
  const anniversaryDate = getAnniversaryDate_(employee);

  if (!anniversaryDate) {
    return requests.slice();
  }

  const cycleStart = getCurrentAnniversaryStart_(employee);

  return requests.filter(function (request) {
    const requestStart = new Date(request.StartDate);

    if (isNaN(requestStart.getTime())) {
      return true;
    }

    return requestStart >= cycleStart;
  });
}

function isApprovedBalanceStatus_(status) {
  return status === STATUS.APPROVED;
}

function isPendingBalanceStatus_(status) {
  return (
    status === STATUS.PENDING_SUPERVISOR ||
    status === STATUS.PENDING_ADMIN
  );
}

function isDeniedBalanceStatus_(status) {
  return (
    status === STATUS.DENIED_SUPERVISOR ||
    status === STATUS.DENIED_ADMIN ||
    status === STATUS.DENIED_SUPERVISOR_EDIT ||
    status === STATUS.DENIED_ADMIN_EDIT
  );
}

function startOfToday_() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

function createCalendarEvent_(employee, request, options) {
  const calendar = getCalendarForEmployee_(employee);
  const eventOptions = options || {};

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
  const title = request.EmployeeName + ' - PTO' + (eventOptions.titleSuffix || '');

  const description =
    'Approved staff time off\n\n' +
    'Employee: ' + request.EmployeeName + '\n' +
    'Request ID: ' + request.RequestId;

  const event = calendar.createAllDayEvent(title, start, end, {
    description: description
  });

  return event.getId();
}

function deleteCalendarEvent_(employee, calendarEventId) {
  if (!calendarEventId) {
    return {
      deleted: false,
      missing: true
    };
  }

  try {
    const calendar = getCalendarForEmployee_(employee);
    const event = calendar.getEventById(calendarEventId);

    if (!event) {
      return {
        deleted: false,
        missing: true
      };
    }

    event.deleteEvent();
    return {
      deleted: true,
      missing: false
    };
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);

    if (message.indexOf('does not exist') >= 0 || message.indexOf('already been deleted') >= 0) {
      return {
        deleted: false,
        missing: true
      };
    }

    throw err;
  }
}

function findCalendarEvent_(employee, calendarEventId) {
  if (!calendarEventId) {
    return null;
  }

  try {
    return getCalendarForEmployee_(employee).getEventById(calendarEventId);
  } catch (err) {
    return null;
  }
}

function getCalendarForEmployee_(employee) {
  const settings = getSettings_();

  const employeeCalendarId = String(employee.CalendarId || '').trim();
  const settingsCalendarId = String(settings.PtoCalendarId || '').trim();

  const calendarId = employeeCalendarId || settingsCalendarId || 'primary';
  const calendar = CalendarApp.getCalendarById(calendarId);

  if (!calendar) {
    throw new Error('Could not find PTO calendar: ' + calendarId);
  }

  return calendar;
}

function applyApprovedEditRequest_(editRequest, employee, warnings) {
  const originalRequest = getRequestById_(editRequest.OriginalRequestId);
  const previousEvent = findCalendarEvent_(employee, originalRequest && originalRequest.CalendarEventId);
  const titleSuffix = previousEvent ? '' : ' (updated)';
  let deleteOutcome = {
    deleted: false,
    missing: !previousEvent
  };

  if (!originalRequest) {
    throw new Error('Original approved request not found for this schedule change.');
  }

  const calendarEventId = createCalendarEvent_(employee, editRequest, {
    titleSuffix: titleSuffix
  });

  if (previousEvent) {
    deleteOutcome = deleteCalendarEvent_(employee, originalRequest.CalendarEventId);
  }

  updateRequest_(originalRequest.RequestId, {
    StartDate: editRequest.StartDate,
    EndDate: editRequest.EndDate,
    HoursRequested: editRequest.HoursRequested,
    Reason: editRequest.Reason,
    Warnings: warnings.join(' | '),
    Status: STATUS.APPROVED,
    SupervisorDecision: 'Approved',
    SupervisorDecisionDate: editRequest.SupervisorDecisionDate || now_(),
    AdminDecision: 'Approved',
    AdminDecisionDate: now_(),
    CalendarEventId: calendarEventId,
    UpdatedAt: now_()
  });

  audit_(
    'system',
    'Applied approved PTO schedule change',
    originalRequest.RequestId,
    JSON.stringify({
      editRequestId: editRequest.RequestId,
      calendarEventId: calendarEventId,
      previousCalendarEventFound: Boolean(previousEvent),
      previousCalendarEventDeleted: Boolean(deleteOutcome.deleted),
      previousCalendarEventMissingAtDelete: Boolean(deleteOutcome.missing)
    })
  );

  return calendarEventId;
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

  const formattedDates =
    formatPtoDate_(request.StartDate) +
    ' to ' +
    formatPtoDate_(request.EndDate);

  const body =
    request.EmployeeName + ' submitted a ' + request.LeaveType + ' request.\n\n' +
    'Dates: ' + formattedDates + '\n' +
    'Hours: ' + request.HoursRequested + '\n' +
    'Reason: ' + (request.Reason || 'No reason provided') + '\n\n' +
    'Please open the PTO app to approve or deny this request.\n\n' +
    'Request ID:\n' + request.RequestId;

  const htmlBody = buildPtoEmailHtml_({
    eyebrow: 'Supervisor Approval Required',
    title: 'New PTO Request',
    intro:
      '<strong>' + escapeHtml_(request.EmployeeName) + '</strong> submitted a ' +
      '<strong>' + escapeHtml_(request.LeaveType) + '</strong> request.',
    details: [
      ['Employee', request.EmployeeName],
      ['Leave type', request.LeaveType],
      ['Dates', formattedDates],
      ['Hours requested', request.HoursRequested],
      ['Reason', request.Reason || 'No reason provided']
    ],
    notice:
      'Please open the PTO app to approve or deny this request.',
    requestId: request.RequestId
  });

  GmailApp.sendEmail(request.SupervisorEmail, subject, body, {
    htmlBody: htmlBody
  });
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

  const subject =
    'PTO request ready for final approval - ' + request.EmployeeName;

  const formattedDates =
    formatPtoDate_(request.StartDate) +
    ' to ' +
    formatPtoDate_(request.EndDate);

  const body =
    request.EmployeeName + '\'s ' +
    request.LeaveType +
    ' request was approved by their supervisor and is ready for final admin approval.\n\n' +
    'Dates: ' + formattedDates + '\n' +
    'Hours: ' + request.HoursRequested + '\n' +
    'Warnings: ' + (request.Warnings || 'None') + '\n\n' +
    'Please open the PTO app to give final approval or denial.\n\n' +
    'Request ID:\n' + request.RequestId;

  const htmlBody = buildPtoEmailHtml_({
    eyebrow: 'Final Approval Required',
    title: 'PTO Request Ready for Admin Review',
    intro:
      '<strong>' + escapeHtml_(request.EmployeeName) + '\'s</strong> ' +
      '<strong>' + escapeHtml_(request.LeaveType) + '</strong> request was ' +
      'approved by their supervisor and is ready for final admin approval.',
    details: [
      ['Employee', request.EmployeeName],
      ['Leave type', request.LeaveType],
      ['Dates', formattedDates],
      ['Hours requested', request.HoursRequested],
      ['Warnings', request.Warnings || 'None']
    ],
    notice:
      'Please open the PTO app to give final approval or denial.',
    requestId: request.RequestId
  });

  GmailApp.sendEmail(admins.join(','), subject, body, {
    htmlBody: htmlBody
  });
}

function sendEditApprovalRequestEmails_(request) {
  const formattedDates =
    formatPtoDate_(request.StartDate) +
    ' to ' +
    formatPtoDate_(request.EndDate);

  if (request.SupervisorEmail) {
    const supervisorSubject =
      'Approved PTO request changed - supervisor review needed';

    const supervisorBody =
      request.EmployeeName +
      ' updated a previously approved ' +
      request.LeaveType +
      ' request.\n\n' +
      'Updated dates: ' + formattedDates + '\n' +
      'Updated hours: ' + request.HoursRequested + '\n' +
      'Reason: ' + (request.Reason || 'No reason provided') + '\n\n' +
      'The existing approved calendar schedule remains in place until this change is approved.\n\n' +
      'Please open the PTO app to review the change.\n\n' +
      'Request ID:\n' + request.RequestId;

    const supervisorHtmlBody = buildPtoEmailHtml_({
      eyebrow: 'Reapproval Required',
      title: 'Approved PTO Request Changed',
      intro:
        '<strong>' + escapeHtml_(request.EmployeeName) +
        '</strong> updated a previously approved ' +
        '<strong>' + escapeHtml_(request.LeaveType) + '</strong> request.',
      details: [
        ['Employee', request.EmployeeName],
        ['Leave type', request.LeaveType],
        ['Updated dates', formattedDates],
        ['Updated hours', request.HoursRequested],
        ['Reason', request.Reason || 'No reason provided']
      ],
      warning:
        'The existing approved calendar schedule remains in place until this change is approved.',
      notice:
        'Please open the PTO app to review the change.',
      requestId: request.RequestId
    });

    GmailApp.sendEmail(
      request.SupervisorEmail,
      supervisorSubject,
      supervisorBody,
      {
        htmlBody: supervisorHtmlBody
      }
    );
  }

  const settings = getSettings_();
  const admins = String(settings.AdminEmails || '')
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);

  if (admins.length) {
    const adminSubject =
      'Approved PTO request changed - admin heads-up';

    const adminBody =
      request.EmployeeName +
      ' updated a previously approved ' +
      request.LeaveType +
      ' request.\n\n' +
      'Updated dates: ' + formattedDates + '\n' +
      'Updated hours: ' + request.HoursRequested + '\n' +
      'Reason: ' + (request.Reason || 'No reason provided') + '\n\n' +
      'The existing approved calendar schedule remains in place until this change finishes reapproval.\n\n' +
      'You will receive a final approval request after supervisor review.\n\n' +
      'Request ID:\n' + request.RequestId;

    const adminHtmlBody = buildPtoEmailHtml_({
      eyebrow: 'PTO Change Notification',
      title: 'Approved PTO Request Changed',
      intro:
        '<strong>' + escapeHtml_(request.EmployeeName) +
        '</strong> updated a previously approved ' +
        '<strong>' + escapeHtml_(request.LeaveType) + '</strong> request.',
      details: [
        ['Employee', request.EmployeeName],
        ['Leave type', request.LeaveType],
        ['Updated dates', formattedDates],
        ['Updated hours', request.HoursRequested],
        ['Reason', request.Reason || 'No reason provided']
      ],
      warning:
        'The existing approved calendar schedule remains in place until this change finishes reapproval.',
      notice:
        'You will receive a final approval request after supervisor review.',
      requestId: request.RequestId
    });

    GmailApp.sendEmail(
      admins.join(','),
      adminSubject,
      adminBody,
      {
        htmlBody: adminHtmlBody
      }
    );
  }
}

function sendEmployeeEmail_(to, subject, body, htmlOptions) {
  if (!htmlOptions) {
    GmailApp.sendEmail(to, subject, body);
    return;
  }

  const htmlBody = buildPtoEmailHtml_(htmlOptions);
  GmailApp.sendEmail(to, subject, body, {
    htmlBody: htmlBody
  });
}

/*******************************
 * Email formatting helpers
 *******************************/

/**
 * Converts a PTO date into a readable format:
 * Monday, July 20, 2026
 */
function formatPtoDate_(dateValue) {
  if (
    dateValue === null ||
    dateValue === undefined ||
    dateValue === ''
  ) {
    return 'Date not provided';
  }

  let date;

  if (dateValue instanceof Date) {
    date = dateValue;
  } else {
    date = new Date(dateValue);
  }

  if (isNaN(date.getTime())) {
    return String(dateValue);
  }

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'EEEE, MMMM d, yyyy'
  );
}

function formatPtoShortDate_(dateValue) {
  if (
    dateValue === null ||
    dateValue === undefined ||
    dateValue === ''
  ) {
    return 'Date not provided';
  }

  let date;

  if (dateValue instanceof Date) {
    date = dateValue;
  } else {
    date = new Date(dateValue);
  }

  if (isNaN(date.getTime())) {
    return String(dateValue);
  }

  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    'M/d/yyyy'
  );
}

function formatPtoDateRange_(startDate, endDate) {
  return formatPtoShortDate_(startDate) + ' to ' + formatPtoShortDate_(endDate);
}

function getPtoEmailActionUrl_() {
  if (PTO_EMAIL_BUTTON_URL) {
    return PTO_EMAIL_BUTTON_URL;
  }

  return getWebAppUrl_();
}

/**
 * Builds the formatted HTML version of a PTO email.
 */
function buildPtoEmailHtml_(options) {
  const actionUrl = options.actionUrl || getPtoEmailActionUrl_();
  const actionLabel = options.actionLabel || 'Open PTO App';
  const detailRows = (options.details || [])
    .map(function (detail) {
      return (
        '<tr>' +
          '<td style="' +
            'padding:10px 14px;' +
            'border-bottom:1px solid #e5e7eb;' +
            'font-size:13px;' +
            'font-weight:bold;' +
            'color:#4b5563;' +
            'width:145px;' +
            'vertical-align:top;' +
          '">' +
            escapeHtml_(detail[0]) +
          '</td>' +
          '<td style="' +
            'padding:10px 14px;' +
            'border-bottom:1px solid #e5e7eb;' +
            'font-size:14px;' +
            'color:#111827;' +
            'vertical-align:top;' +
            'word-break:break-word;' +
          '">' +
            formatEmailValue_(detail[1]) +
          '</td>' +
        '</tr>'
      );
    })
    .join('');

  const warningBlock = options.warning
    ? (
      '<div style="' +
        'margin:22px 0 0;' +
        'padding:14px 16px;' +
        'background-color:#fff7ed;' +
        'border-left:4px solid #f59e0b;' +
        'font-size:14px;' +
        'line-height:21px;' +
        'color:#7c2d12;' +
      '">' +
        escapeHtml_(options.warning) +
      '</div>'
    )
    : '';

  const noticeBlock = options.notice
    ? (
      '<div style="' +
        'margin:22px 0 0;' +
        'padding:16px;' +
        'background-color:#eff6ff;' +
        'border:1px solid #bfdbfe;' +
        'border-radius:6px;' +
        'font-size:14px;' +
        'line-height:21px;' +
        'color:#1e3a5f;' +
      '">' +
        '<strong>Next step:</strong> ' +
        escapeHtml_(options.notice) +
      '</div>'
    )
    : '';

  const actionBlock = actionUrl
    ? (
      '<div style="margin:22px 0 0;">' +
        '<a href="' + escapeHtml_(actionUrl) + '" style="' +
          'display:inline-block;' +
          'background-color:#85431e;' +
          'color:#ffffff;' +
          'text-decoration:none;' +
          'padding:12px 18px;' +
          'border-radius:6px;' +
          'font-size:14px;' +
          'font-weight:bold;' +
        '">' +
          escapeHtml_(actionLabel) +
        '</a>' +
      '</div>'
    )
    : '';

  return (
    '<!DOCTYPE html>' +
    '<html>' +
    '<body style="' +
      'margin:0;' +
      'padding:0;' +
      'background-color:#f3f4f6;' +
      'font-family:Arial,Helvetica,sans-serif;' +
      'color:#111827;' +
    '">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
        'style="width:100%;background-color:#f3f4f6;margin:0;padding:0;">' +
        '<tr>' +
          '<td align="center" style="padding:28px 12px;">' +
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
              'style="' +
                'width:100%;' +
                'max-width:640px;' +
                'background-color:#ffffff;' +
                'border:1px solid #d1d5db;' +
                'border-radius:8px;' +
                'overflow:hidden;' +
              '">' +
              '<tr>' +
                '<td style="' +
                  'padding:24px 28px;' +
                  'background-color:#333f48;' +
                '">' +
                  '<div style="' +
                    'font-size:11px;' +
                    'font-weight:bold;' +
                    'letter-spacing:1.5px;' +
                    'text-transform:uppercase;' +
                    'color:#efdbb2;' +
                    'margin-bottom:8px;' +
                  '">' +
                    escapeHtml_(options.eyebrow || 'PTO Request') +
                  '</div>' +
                  '<div style="' +
                    'font-size:24px;' +
                    'line-height:30px;' +
                    'font-weight:bold;' +
                    'color:#ffffff;' +
                  '">' +
                    escapeHtml_(options.title || 'PTO Request') +
                  '</div>' +
                '</td>' +
              '</tr>' +
              '<tr>' +
                '<td style="padding:26px 28px;">' +
                  '<div style="' +
                    'font-size:15px;' +
                    'line-height:23px;' +
                    'color:#374151;' +
                    'margin-bottom:22px;' +
                  '">' +
                    options.intro +
                  '</div>' +
                  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
                    'style="' +
                      'width:100%;' +
                      'border:1px solid #d1d5db;' +
                      'border-radius:6px;' +
                      'border-collapse:separate;' +
                      'border-spacing:0;' +
                      'overflow:hidden;' +
                    '">' +
                    detailRows +
                  '</table>' +
                  warningBlock +
                  noticeBlock +
                  actionBlock +
                  '<div style="' +
                    'margin-top:24px;' +
                    'padding-top:18px;' +
                    'border-top:1px solid #e5e7eb;' +
                    'font-size:12px;' +
                    'line-height:18px;' +
                    'color:#6b7280;' +
                  '">' +
                    '<strong>Request ID</strong><br>' +
                    '<span style="' +
                      'font-family:Courier New,Courier,monospace;' +
                      'color:#374151;' +
                      'word-break:break-all;' +
                    '">' +
                      escapeHtml_(options.requestId || '') +
                    '</span>' +
                  '</div>' +
                '</td>' +
              '</tr>' +
              '<tr>' +
                '<td style="' +
                  'padding:16px 28px;' +
                  'background-color:#f9fafb;' +
                  'border-top:1px solid #e5e7eb;' +
                  'font-size:11px;' +
                  'line-height:17px;' +
                  'color:#6b7280;' +
                '">' +
                  'This is an automated PTO notification.' +
                '</td>' +
              '</tr>' +
            '</table>' +
          '</td>' +
        '</tr>' +
      '</table>' +
    '</body>' +
    '</html>'
  );
}

/**
 * Safely formats values placed inside the HTML detail table.
 */
function formatEmailValue_(value) {
  const safeValue =
    value === null ||
    value === undefined ||
    value === ''
      ? 'Not provided'
      : String(value);

  return escapeHtml_(safeValue).replace(/\r?\n/g, '<br>');
}

/**
 * Prevents request data from breaking the email HTML.
 */
function escapeHtml_(value) {
  return String(
    value === null || value === undefined
      ? ''
      : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  ensureRequestSheetColumns_();
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

function isEditRequest_(request) {
  return lower_(request.ChangeType) === 'edit';
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

function ensureRequestSheetColumns_() {
  ensureSheetColumns_(SHEETS.REQUESTS, REQUEST_METADATA_COLUMNS);
}

function ensureSheetColumns_(sheetName, requiredHeaders) {
  const sh = SpreadsheetApp.getActive().getSheetByName(sheetName);

  if (!sh) {
    throw new Error('Missing sheet: ' + sheetName);
  }

  const lastColumn = Math.max(sh.getLastColumn(), 1);
  const headers = sh.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (header) {
      return String(header).trim();
    });

  requiredHeaders.forEach(function (header) {
    if (headers.indexOf(header) >= 0) {
      return;
    }

    sh.getRange(1, headers.length + 1).setValue(header);
    headers.push(header);
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
