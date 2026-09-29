import { formatDisplayDate, formatKzt, type TranslationDict } from '../i18n/translations';
import { apiFetch } from '../services/api';

/**
 * Strict HTML entity escaping for print/PDF templates (Rule 8: Prevent XSS in print layouts).
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openPrintWindow(title: string, bodyHtml: string): void {
  const win = window.open('', '_blank', 'width=900,height=750');
  if (!win) {
    window.print();
    return;
  }

  const doc = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0F172A;
      margin: 0;
      padding: 32px;
      line-height: 1.5;
      font-size: 13px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #0F172A;
      padding-bottom: 14px;
      margin-bottom: 22px;
    }
    .clinic-name { font-size: 18px; font-weight: 700; color: #0F172A; }
    .clinic-sub { font-size: 12px; color: #475569; margin-top: 2px; }
    .doc-title { font-size: 16px; font-weight: 700; margin: 16px 0 12px; color: #0F172A; }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 10px 24px;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 8px;
      padding: 14px 18px;
      margin-bottom: 20px;
    }
    .field-label { font-size: 11px; color: #64748B; text-transform: uppercase; letter-spacing: 0.04em; }
    .field-val { font-size: 13px; font-weight: 600; color: #0F172A; margin-top: 2px; }
    .allergy-box {
      border: 1px solid #DC2626;
      background: #FEF2F2;
      color: #991B1B;
      padding: 8px 12px;
      border-radius: 6px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    th, td {
      border: 1px solid #CBD5E1;
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #F1F5F9;
      font-weight: 700;
      font-size: 12px;
    }
    .summary-row {
      display: flex;
      gap: 24px;
      margin: 16px 0;
      padding: 12px 16px;
      border: 1px solid #CBD5E1;
      border-radius: 8px;
    }
    .footer {
      margin-top: 36px;
      padding-top: 12px;
      border-top: 1px solid #CBD5E1;
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #64748B;
    }
    @media print {
      body { padding: 12px; }
    }
  </style>
</head>
<body>
  ${bodyHtml}
  <script>
    window.onload = function() {
      window.focus();
      window.print();
    };
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(doc);
  win.document.close();
}

export function printPatientCardAndHistory(params: {
  clinic: { name?: string; phone?: string; subtitle?: string } | null;
  patient: any;
  summary: {
    visitCount: number;
    totalServicesAmount: number;
    totalPaid: number;
    outstandingAmount: number;
  };
  visits: any[];
  t: TranslationDict;
}): void {
  const { clinic, patient, summary, visits, t } = params;
  apiFetch('/api/settings/audit-print', {
    method: 'POST',
    body: { documentType: 'patient_card', entityId: patient.id },
  }).catch(() => {});

  const rowsHtml = visits
    .map(
      (v) => `
      <tr>
        <td>${escapeHtml(formatDisplayDate(v.visit_date))} ${escapeHtml(v.visit_time || '')}</td>
        <td>
          <strong>${escapeHtml(v.service_name_snapshot)}</strong>
          ${v.diagnosis ? `<br/><small>${escapeHtml(t.visit.diagnosis)}: ${escapeHtml(v.diagnosis)}</small>` : ''}
          ${v.treatment ? `<br/><small>${escapeHtml(t.visit.treatment)}: ${escapeHtml(v.treatment)}</small>` : ''}
        </td>
        <td>${escapeHtml(formatKzt(v.price))}</td>
        <td>${escapeHtml(v.payment_status === 'paid' ? t.patients.paid : t.patients.unpaid)}</td>
        <td>${escapeHtml(v.doctor_name || '—')}</td>
      </tr>`
    )
    .join('');

  const html = `
    <div class="header">
      <div>
        <div class="clinic-name">${escapeHtml(clinic?.name || t.appName)}</div>
        <div class="clinic-sub">${escapeHtml(clinic?.subtitle || '')} ${escapeHtml(clinic?.phone || '')}</div>
      </div>
      <div class="clinic-sub">${escapeHtml(formatDisplayDate(new Date().toISOString()))}</div>
    </div>

    <div class="doc-title">${escapeHtml(patient.full_name)}</div>

    ${
      patient.allergies
        ? `<div class="allergy-box">${escapeHtml(t.patients.allergies)}: ${escapeHtml(patient.allergies)}</div>`
        : ''
    }

    <div class="grid">
      <div>
        <div class="field-label">${escapeHtml(t.patients.phone)}</div>
        <div class="field-val">${escapeHtml(patient.phone || '—')}</div>
      </div>
      <div>
        <div class="field-label">${escapeHtml(t.patients.dob)}</div>
        <div class="field-val">${escapeHtml(formatDisplayDate(patient.date_of_birth))}</div>
      </div>
      <div>
        <div class="field-label">ИИН / IIN</div>
        <div class="field-val">${escapeHtml(patient.iin_masked || '—')}</div>
      </div>
      <div>
        <div class="field-label">${escapeHtml(t.patients.medicalNotes)}</div>
        <div class="field-val">${escapeHtml(patient.medical_notes || '—')}</div>
      </div>
    </div>

    <div class="summary-row">
      <div><strong>${escapeHtml(t.patients.visitsCount)}:</strong> ${escapeHtml(summary.visitCount)}</div>
      <div><strong>${escapeHtml(t.patients.totalServices)}:</strong> ${escapeHtml(formatKzt(summary.totalServicesAmount))}</div>
      <div><strong>${escapeHtml(t.patients.totalPaid)}:</strong> ${escapeHtml(formatKzt(summary.totalPaid))}</div>
      <div><strong>${escapeHtml(t.patients.outstanding)}:</strong> ${escapeHtml(formatKzt(summary.outstandingAmount))}</div>
    </div>

    <div class="doc-title">${escapeHtml(t.patients.treatmentHistory)}</div>
    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t.patients.date)}</th>
          <th>${escapeHtml(t.patients.service)}</th>
          <th>${escapeHtml(t.patients.price)}</th>
          <th>${escapeHtml(t.patients.paymentStatus)}</th>
          <th>${escapeHtml(t.patients.doctor)}</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || `<tr><td colspan="5">${escapeHtml(t.patients.emptyHistory)}</td></tr>`}
      </tbody>
    </table>

    <div class="footer">
      <div>${escapeHtml(clinic?.name || t.appName)}</div>
      <div>Подпись врача / Doctor Signature: _______________________</div>
    </div>
  `;

  openPrintWindow(patient.full_name, html);
}

export function printSingleVisitDetail(params: {
  clinic: { name?: string; phone?: string; subtitle?: string } | null;
  patientName: string;
  visit: any;
  t: TranslationDict;
}): void {
  const { clinic, patientName, visit, t } = params;
  apiFetch('/api/settings/audit-print', {
    method: 'POST',
    body: { documentType: 'visit_detail', entityId: visit.id },
  }).catch(() => {});

  const html = `
    <div class="header">
      <div>
        <div class="clinic-name">${escapeHtml(clinic?.name || t.appName)}</div>
        <div class="clinic-sub">${escapeHtml(clinic?.subtitle || '')} ${escapeHtml(clinic?.phone || '')}</div>
      </div>
      <div class="clinic-sub">${escapeHtml(formatDisplayDate(visit.visit_date))} ${escapeHtml(visit.visit_time || '')}</div>
    </div>

    <div class="doc-title">${escapeHtml(t.visit.detailTitle)} — ${escapeHtml(patientName)}</div>

    <div class="grid">
      <div>
        <div class="field-label">${escapeHtml(t.patients.service)}</div>
        <div class="field-val">${escapeHtml(visit.service_name_snapshot)}</div>
      </div>
      <div>
        <div class="field-label">${escapeHtml(t.patients.price)}</div>
        <div class="field-val">${escapeHtml(formatKzt(visit.price))} (${escapeHtml(
    visit.payment_status === 'paid' ? t.patients.paid : t.patients.unpaid
  )})</div>
      </div>
      <div>
        <div class="field-label">${escapeHtml(t.patients.doctor)}</div>
        <div class="field-val">${escapeHtml(visit.doctor_name || '—')}</div>
      </div>
      <div>
        <div class="field-label">${escapeHtml(t.patients.paymentDate)}</div>
        <div class="field-val">${escapeHtml(formatDisplayDate(visit.payment_date))}</div>
      </div>
    </div>

    <table>
      <tbody>
        ${
          visit.complaints
            ? `<tr><th style="width:180px">${escapeHtml(t.visit.complaints)}</th><td>${escapeHtml(visit.complaints)}</td></tr>`
            : ''
        }
        ${
          visit.diagnosis
            ? `<tr><th>${escapeHtml(t.visit.diagnosis)}</th><td>${escapeHtml(visit.diagnosis)}</td></tr>`
            : ''
        }
        ${
          visit.treatment
            ? `<tr><th>${escapeHtml(t.visit.treatment)}</th><td>${escapeHtml(visit.treatment)}</td></tr>`
            : ''
        }
        ${
          visit.recommendations
            ? `<tr><th>${escapeHtml(t.visit.recommendations)}</th><td>${escapeHtml(visit.recommendations)}</td></tr>`
            : ''
        }
        ${
          visit.comments
            ? `<tr><th>${escapeHtml(t.visit.comments)}</th><td>${escapeHtml(visit.comments)}</td></tr>`
            : ''
        }
      </tbody>
    </table>

    <div class="footer">
      <div>${escapeHtml(clinic?.name || t.appName)}</div>
      <div>Подпись врача / Doctor Signature: _______________________</div>
    </div>
  `;

  openPrintWindow(`${patientName} - ${visit.visit_date}`, html);
}

export function printFinancialReport(params: {
  clinic: { name?: string; phone?: string; subtitle?: string } | null;
  period: { from: string; to: string };
  summary: {
    visitCount: number;
    totalServicesAmount: number;
    totalPaid: number;
    unpaidAmount: number;
  };
  visits: any[];
  t: TranslationDict;
}): void {
  const { clinic, period, summary, visits, t } = params;
  apiFetch('/api/settings/audit-print', {
    method: 'POST',
    body: { documentType: 'finance_summary' },
  }).catch(() => {});

  const rowsHtml = visits
    .map(
      (v) => `
      <tr>
        <td>${escapeHtml(formatDisplayDate(v.visit_date))}</td>
        <td>${escapeHtml(v.patient_name)}</td>
        <td>${escapeHtml(v.service_name_snapshot)}</td>
        <td>${escapeHtml(formatKzt(v.price))}</td>
        <td>${escapeHtml(v.payment_status === 'paid' ? t.patients.paid : t.patients.unpaid)}</td>
        <td>${escapeHtml(v.doctor_name || '—')}</td>
      </tr>`
    )
    .join('');

  const html = `
    <div class="header">
      <div>
        <div class="clinic-name">${escapeHtml(clinic?.name || t.appName)}</div>
        <div class="clinic-sub">${escapeHtml(clinic?.subtitle || '')}</div>
      </div>
      <div class="clinic-sub">${escapeHtml(formatDisplayDate(period.from))} — ${escapeHtml(formatDisplayDate(period.to))}</div>
    </div>

    <div class="doc-title">${escapeHtml(t.finances.title)} (${escapeHtml(formatDisplayDate(period.from))} – ${escapeHtml(formatDisplayDate(period.to))})</div>

    <div class="summary-row">
      <div><strong>${escapeHtml(t.finances.totalServices)}:</strong> ${escapeHtml(formatKzt(summary.totalServicesAmount))}</div>
      <div><strong>${escapeHtml(t.finances.totalPaid)}:</strong> ${escapeHtml(formatKzt(summary.totalPaid))}</div>
      <div><strong>${escapeHtml(t.finances.totalUnpaid)}:</strong> ${escapeHtml(formatKzt(summary.unpaidAmount))}</div>
      <div><strong>${escapeHtml(t.finances.visitsCount)}:</strong> ${escapeHtml(summary.visitCount)}</div>
    </div>

    <table>
      <thead>
        <tr>
          <th>${escapeHtml(t.patients.date)}</th>
          <th>${escapeHtml(t.calendar.patientLabel)}</th>
          <th>${escapeHtml(t.patients.service)}</th>
          <th>${escapeHtml(t.patients.price)}</th>
          <th>${escapeHtml(t.patients.paymentStatus)}</th>
          <th>${escapeHtml(t.patients.doctor)}</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  openPrintWindow(`${t.finances.title} ${period.from} - ${period.to}`, html);
}
