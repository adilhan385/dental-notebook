import React, { useState, useEffect, useCallback } from 'react';
import { Printer, Check } from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';
import { printFinancialReport } from '../utils/print';

interface Props {
  t: TranslationDict;
  clinic: any;
  onOpenPatient: (patientId: string) => void;
}

export function FinancesView({ t, clinic, onOpenPatient }: Props) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const firstOfMonthIso = `${todayIso.slice(0, 7)}-01`;

  const [preset, setPreset] = useState<'today' | 'week' | 'month' | 'custom'>('month');
  const [fromDate, setFromDate] = useState(firstOfMonthIso);
  const [toDate, setToDate] = useState(todayIso);
  const [statusFilter, setStatusFilter] = useState<'all' | 'paid' | 'unpaid'>('all');

  const [summary, setSummary] = useState({
    visitCount: 0,
    totalServicesAmount: 0,
    totalPaid: 0,
    unpaidAmount: 0,
  });
  const [visits, setVisits] = useState<any[]>([]);

  function applyPreset(p: 'today' | 'week' | 'month' | 'custom') {
    setPreset(p);
    const now = new Date();
    const tIso = now.toISOString().slice(0, 10);
    if (p === 'today') {
      setFromDate(tIso);
      setToDate(tIso);
    } else if (p === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      setFromDate(d.toISOString().slice(0, 10));
      setToDate(tIso);
    } else if (p === 'month') {
      setFromDate(`${tIso.slice(0, 7)}-01`);
      setToDate(tIso);
    }
  }

  const loadFinanceData = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/finances/summary?from=${fromDate}&to=${toDate}&status=${statusFilter}`
      );
      if (res.summary) setSummary(res.summary);
      setVisits(res.visits || []);
    } catch {
      // handled
    }
  }, [fromDate, toDate, statusFilter]);

  useEffect(() => {
    loadFinanceData();
  }, [loadFinanceData]);

  async function handleMarkPaid(visitId: string) {
    await apiFetch(`/api/visits/${visitId}`, {
      method: 'PATCH',
      body: {
        payment_status: 'paid',
        payment_date: new Date().toISOString().slice(0, 10),
      },
    });
    loadFinanceData();
  }

  return (
    <div className="page-stack">
      <div className="card">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t.finances.title}</h1>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="segmented-tabs">
              <button
                type="button"
                className={`seg-tab ${preset === 'today' ? 'active' : ''}`}
                onClick={() => applyPreset('today')}
              >
                {t.finances.periodToday}
              </button>
              <button
                type="button"
                className={`seg-tab ${preset === 'week' ? 'active' : ''}`}
                onClick={() => applyPreset('week')}
              >
                {t.finances.periodWeek}
              </button>
              <button
                type="button"
                className={`seg-tab ${preset === 'month' ? 'active' : ''}`}
                onClick={() => applyPreset('month')}
              >
                {t.finances.periodMonth}
              </button>
              <button
                type="button"
                className={`seg-tab ${preset === 'custom' ? 'active' : ''}`}
                onClick={() => applyPreset('custom')}
              >
                {t.finances.periodCustom}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="date"
                className="input input-sm"
                value={fromDate}
                onChange={(e) => {
                  setPreset('custom');
                  setFromDate(e.target.value);
                }}
              />
              <span>—</span>
              <input
                type="date"
                className="input input-sm"
                value={toDate}
                onChange={(e) => {
                  setPreset('custom');
                  setToDate(e.target.value);
                }}
              />
            </div>

            <button
              className="btn btn-secondary"
              onClick={() =>
                printFinancialReport({
                  clinic,
                  period: { from: fromDate, to: toDate },
                  summary,
                  visits,
                  t,
                })
              }
            >
              <Printer size={15} />
              <span>{t.finances.printReportBtn}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Period Summary Metric Cards */}
      <div className="metrics-grid-4">
        <div className="metric-card">
          <div className="metric-label">{t.finances.totalServices}</div>
          <div className="metric-value">
            {formatKzt(summary.totalServicesAmount)}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.finances.totalPaid}</div>
          <div className="metric-value metric-paid">
            {formatKzt(summary.totalPaid)}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.finances.totalUnpaid}</div>
          <div
            className={`metric-value ${
              summary.unpaidAmount > 0 ? 'metric-unpaid' : ''
            }`}
          >
            {formatKzt(summary.unpaidAmount)}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">{t.finances.visitsCount}</div>
          <div className="metric-value">{summary.visitCount}</div>
        </div>
      </div>

      {/* Visits Breakdown Table */}
      <div className="card">
        <div className="row-between" style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontWeight: 600 }}>
            {formatDisplayDate(fromDate)} – {formatDisplayDate(toDate)}
          </div>
          <div className="segmented-tabs">
            <button
              type="button"
              className={`seg-tab ${statusFilter === 'all' ? 'active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              {t.finances.filterAll}
            </button>
            <button
              type="button"
              className={`seg-tab ${statusFilter === 'paid' ? 'active' : ''}`}
              onClick={() => setStatusFilter('paid')}
            >
              {t.finances.filterPaid}
            </button>
            <button
              type="button"
              className={`seg-tab ${statusFilter === 'unpaid' ? 'active' : ''}`}
              onClick={() => setStatusFilter('unpaid')}
            >
              {t.finances.filterUnpaid}
            </button>
          </div>
        </div>

        <div className="table-responsive">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.patients.date}</th>
                <th>{t.calendar.patientLabel}</th>
                <th>{t.patients.service}</th>
                <th>{t.patients.price}</th>
                <th>{t.patients.paymentStatus}</th>
                <th>{t.patients.doctor}</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id}>
                  <td>{formatDisplayDate(v.visit_date)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn-link"
                      style={{ fontWeight: 600 }}
                      onClick={() => onOpenPatient(v.patient_id)}
                    >
                      {v.patient_name}
                    </button>
                  </td>
                  <td>{v.service_name_snapshot}</td>
                  <td style={{ fontWeight: 600 }}>{formatKzt(v.price)}</td>
                  <td>
                    <span
                      className={`badge ${
                        v.payment_status === 'paid'
                          ? 'badge-success'
                          : 'badge-warning'
                      }`}
                    >
                      {v.payment_status === 'paid'
                        ? t.patients.paid
                        : t.patients.unpaid}
                    </span>
                    {v.payment_status === 'unpaid' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        style={{ marginLeft: 8 }}
                        onClick={() => handleMarkPaid(v.id)}
                      >
                        <Check size={14} />
                        <span>{t.finances.markPaidBtn}</span>
                      </button>
                    )}
                  </td>
                  <td>{v.doctor_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
