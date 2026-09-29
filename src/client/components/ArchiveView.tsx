import React, { useState, useEffect, useCallback } from 'react';
import { Search, RotateCcw, Trash2, AlertTriangle, X } from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
}

export function ArchiveView({ t }: Props) {
  const [search, setSearch] = useState('');
  const [archivedPatients, setArchivedPatients] = useState<any[]>([]);
  const [archivedVisits, setArchivedVisits] = useState<any[]>([]);

  const [deleteTarget, setDeleteTarget] = useState<{
    type: 'patient' | 'visit';
    id: string;
    label: string;
  } | null>(null);
  const [confirmInput, setConfirmInput] = useState('');
  const [error, setError] = useState('');

  const loadArchive = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/api/archive?q=${encodeURIComponent(search.trim())}`
      );
      setArchivedPatients(res.archivedPatients || []);
      setArchivedVisits(res.archivedVisits || []);
    } catch {
      // handled
    }
  }, [search]);

  useEffect(() => {
    loadArchive();
  }, [loadArchive]);

  async function handleRestorePatient(id: string) {
    await apiFetch(`/api/patients/${id}/restore`, { method: 'POST' });
    loadArchive();
  }

  async function handleRestoreVisit(id: string) {
    await apiFetch(`/api/visits/${id}/restore`, { method: 'POST' });
    loadArchive();
  }

  const isConfirmValid = ['УДАЛИТЬ', 'ЖОЮ', 'DELETE'].includes(
    confirmInput.trim()
  );

  async function handlePermanentDelete(e: React.FormEvent) {
    e.preventDefault();
    if (!deleteTarget || !isConfirmValid) return;
    setError('');

    try {
      const endpoint =
        deleteTarget.type === 'patient'
          ? `/api/patients/${deleteTarget.id}/permanent`
          : `/api/visits/${deleteTarget.id}/permanent`;

      await apiFetch(endpoint, {
        method: 'DELETE',
        body: { confirmationText: confirmInput.trim() },
      });
      setDeleteTarget(null);
      setConfirmInput('');
      loadArchive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  }

  return (
    <div className="page-stack">
      <div className="card">
        <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 22 }}>{t.archive.title}</h1>
          <div className="search-input-wrapper" style={{ maxWidth: 340 }}>
            <Search size={16} className="search-input-icon" />
            <input
              type="search"
              className="input input-with-icon"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t.archive.searchPlaceholder}
            />
          </div>
        </div>
      </div>

      {/* Archived Patients */}
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {t.archive.archivedPatients} ({archivedPatients.length})
        </h2>

        {archivedPatients.length === 0 ? (
          <div className="muted">{t.archive.emptyArchive}</div>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.patients.fullName}</th>
                  <th>{t.patients.phone}</th>
                  <th>ИИН</th>
                  <th>{t.archive.archivedDate}</th>
                  <th style={{ textAlign: 'right' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {archivedPatients.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.full_name}</td>
                    <td>{p.phone || '—'}</td>
                    <td>{p.iin_masked || '—'}</td>
                    <td>{formatDisplayDate(p.archived_at)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginRight: 8 }}
                        onClick={() => handleRestorePatient(p.id)}
                      >
                        <RotateCcw size={14} />
                        <span>{t.archive.restoreBtn}</span>
                      </button>
                      <button
                        className="btn btn-danger-outline btn-sm"
                        onClick={() => {
                          setDeleteTarget({
                            type: 'patient',
                            id: p.id,
                            label: p.full_name,
                          });
                          setConfirmInput('');
                        }}
                      >
                        <Trash2 size={14} />
                        <span>{t.archive.permanentDeleteBtn}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Archived Visits */}
      <div className="card">
        <h2 className="section-title" style={{ marginTop: 0 }}>
          {t.archive.archivedVisits} ({archivedVisits.length})
        </h2>

        {archivedVisits.length === 0 ? (
          <div className="muted">{t.archive.emptyArchive}</div>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.patients.date}</th>
                  <th>{t.calendar.patientLabel}</th>
                  <th>{t.patients.service}</th>
                  <th>{t.patients.price}</th>
                  <th>{t.archive.archivedDate}</th>
                  <th style={{ textAlign: 'right' }}>Действия</th>
                </tr>
              </thead>
              <tbody>
                {archivedVisits.map((v) => (
                  <tr key={v.id}>
                    <td>{formatDisplayDate(v.visit_date)}</td>
                    <td style={{ fontWeight: 600 }}>{v.patient_name}</td>
                    <td>{v.service_name_snapshot}</td>
                    <td>{formatKzt(v.price)}</td>
                    <td>{formatDisplayDate(v.archived_at)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginRight: 8 }}
                        onClick={() => handleRestoreVisit(v.id)}
                      >
                        <RotateCcw size={14} />
                        <span>{t.archive.restoreBtn}</span>
                      </button>
                      <button
                        className="btn btn-danger-outline btn-sm"
                        onClick={() => {
                          setDeleteTarget({
                            type: 'visit',
                            id: v.id,
                            label: `${v.patient_name} — ${v.service_name_snapshot}`,
                          });
                          setConfirmInput('');
                        }}
                      >
                        <Trash2 size={14} />
                        <span>{t.archive.permanentDeleteBtn}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Serious Destructive Permanent Delete Modal */}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          onClick={() => setDeleteTarget(null)}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="icon-inline" style={{ color: '#991B1B' }}>
                <AlertTriangle size={18} />
                <span>{t.archive.confirmDeleteTitle}</span>
              </h3>
              <button
                className="btn-icon"
                onClick={() => setDeleteTarget(null)}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handlePermanentDelete} className="form-stack">
              {error && <div className="alert alert-error">{error}</div>}

              <div className="allergy-banner">
                <div style={{ marginBottom: 6, fontWeight: 700 }}>
                  {deleteTarget.label}
                </div>
                <div>{t.archive.confirmDeleteWarn1}</div>
                <div>{t.archive.confirmDeleteWarn2}</div>
                <div>{t.archive.confirmDeleteWarn3}</div>
                <div>{t.archive.confirmDeleteWarn4}</div>
              </div>

              <div className="form-group">
                <label>{t.archive.typeDeletePrompt}</label>
                <input
                  type="text"
                  className="input"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  placeholder={t.archive.confirmWord}
                  autoFocus
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setDeleteTarget(null)}
                >
                  {t.patients.cancelBtn}
                </button>
                <button
                  type="submit"
                  className="btn btn-danger"
                  disabled={!isConfirmValid}
                >
                  <Trash2 size={15} />
                  <span>{t.archive.permanentDeleteBtn}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
