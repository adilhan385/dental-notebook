import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Minus, AlertTriangle, X } from 'lucide-react';
import {
  formatDisplayDate,
  formatKzt,
  type TranslationDict,
} from '../i18n/translations';
import { apiFetch } from '../services/api';

interface Props {
  t: TranslationDict;
}

export function InventoryView({ t }: Props) {
  const [items, setItems] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [showAddItem, setShowAddItem] = useState(false);
  const [txItem, setTxItem] = useState<any | null>(null);
  const [txType, setTxType] = useState<'incoming' | 'usage' | 'write_off'>('usage');
  const [txQty, setTxQty] = useState('1');
  const [txComment, setTxComment] = useState('');
  const [error, setError] = useState('');

  // New Item Form
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [quantity, setQuantity] = useState('10');
  const [unit, setUnit] = useState('шт');
  const [purchasePrice, setPurchasePrice] = useState('');
  const [minStock, setMinStock] = useState('5');
  const [expDate, setExpDate] = useState('');

  const loadInventory = useCallback(async () => {
    try {
      const res = await apiFetch('/api/inventory');
      setItems(res.items || []);
      setTransactions(res.transactions || []);
    } catch {
      // handled
    }
  }, []);

  useEffect(() => {
    loadInventory();
  }, [loadInventory]);

  const lowStockItems = items.filter((i) => i.is_low_stock);

  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await apiFetch('/api/inventory/items', {
        method: 'POST',
        body: {
          name: name.trim(),
          category: category.trim() || null,
          quantity: Number(quantity || 0),
          unit: unit.trim() || 'шт',
          purchase_price: purchasePrice ? Number(purchasePrice) : null,
          minimum_stock: minStock ? Number(minStock) : null,
          expiration_date: expDate || null,
        },
      });
      setName('');
      setCategory('');
      setShowAddItem(false);
      loadInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка добавления материала');
    }
  }

  async function handleRecordTransaction(e: React.FormEvent) {
    e.preventDefault();
    if (!txItem) return;
    setError('');
    try {
      await apiFetch('/api/inventory/transactions', {
        method: 'POST',
        body: {
          inventory_item_id: txItem.id,
          type: txType,
          quantity: Number(txQty),
          transaction_date: new Date().toISOString().slice(0, 10),
          comment: txComment.trim() || null,
        },
      });
      setTxItem(null);
      setTxQty('1');
      setTxComment('');
      loadInventory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка проведения операции');
    }
  }

  return (
    <div className="page-stack">
      <div className="card">
        <div className="row-between">
          <h1 style={{ margin: 0, fontSize: 22 }}>{t.inventory.title}</h1>
          <button
            className="btn btn-primary"
            onClick={() => setShowAddItem(true)}
          >
            <Plus size={16} />
            <span>{t.inventory.addItemBtn.replace(/^\+\s*/, '')}</span>
          </button>
        </div>

        {lowStockItems.length > 0 && (
          <div className="allergy-banner icon-inline" style={{ marginTop: 14 }}>
            <AlertTriangle size={16} />
            <span>
              <strong>{t.inventory.lowStockWarning}</strong>{' '}
              {lowStockItems
                .map((i) => `${i.name} (${i.quantity} ${i.unit})`)
                .join(' • ')}
            </span>
          </div>
        )}
      </div>

      {/* Inventory Items Table */}
      <div className="card">
        {items.length === 0 ? (
          <div className="empty-state">
            <p>{t.inventory.empty}</p>
            <button
              className="btn btn-primary"
              onClick={() => setShowAddItem(true)}
            >
              <Plus size={16} />
              <span>{t.inventory.addItemBtn.replace(/^\+\s*/, '')}</span>
            </button>
          </div>
        ) : (
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.inventory.itemName}</th>
                  <th>{t.inventory.category}</th>
                  <th>{t.inventory.quantity}</th>
                  <th>{t.inventory.minStock}</th>
                  <th>{t.inventory.purchasePrice}</th>
                  <th>{t.inventory.expirationDate}</th>
                  <th style={{ textAlign: 'right' }}>
                    {t.inventory.recordTxBtn}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td>{item.category || '—'}</td>
                    <td>
                      <span
                        className={`badge ${
                          item.is_low_stock ? 'badge-warning' : 'badge-success'
                        }`}
                      >
                        {item.quantity} {item.unit}
                      </span>
                    </td>
                    <td>
                      {item.minimum_stock !== null
                        ? `${item.minimum_stock} ${item.unit}`
                        : '—'}
                    </td>
                    <td>
                      {item.purchase_price !== null
                        ? formatKzt(item.purchase_price)
                        : '—'}
                    </td>
                    <td>{formatDisplayDate(item.expiration_date)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ marginRight: 6 }}
                        onClick={() => {
                          setTxItem(item);
                          setTxType('incoming');
                        }}
                      >
                        <Plus size={14} />
                        <span>{t.inventory.incoming}</span>
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ marginRight: 6 }}
                        onClick={() => {
                          setTxItem(item);
                          setTxType('usage');
                        }}
                      >
                        <Minus size={14} />
                        <span>{t.inventory.usage}</span>
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          setTxItem(item);
                          setTxType('write_off');
                        }}
                      >
                        <X size={14} />
                        <span>{t.inventory.writeOff}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Stock Transactions Log */}
      {transactions.length > 0 && (
        <div className="card">
          <h3 className="section-title" style={{ marginTop: 0 }}>
            {t.inventory.txHistory}
          </h3>
          <div className="table-responsive">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t.patients.date}</th>
                  <th>{t.inventory.itemName}</th>
                  <th>Тип</th>
                  <th>Количество</th>
                  <th>{t.visit.comments}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.slice(0, 20).map((tx) => (
                  <tr key={tx.id}>
                    <td>{formatDisplayDate(tx.transaction_date)}</td>
                    <td style={{ fontWeight: 600 }}>{tx.item_name}</td>
                    <td>
                      {tx.type === 'incoming'
                        ? t.inventory.incoming
                        : tx.type === 'usage'
                        ? t.inventory.usage
                        : t.inventory.writeOff}
                    </td>
                    <td>
                      {tx.type === 'incoming' ? '+' : '−'}
                      {tx.quantity} {tx.item_unit}
                    </td>
                    <td>{tx.comment || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add Material Modal */}
      {showAddItem && (
        <div className="modal-backdrop" onClick={() => setShowAddItem(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t.inventory.addItemBtn.replace(/^\+\s*/, '')}</h3>
              <button
                className="btn-icon"
                onClick={() => setShowAddItem(false)}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleAddItem} className="form-stack">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group">
                <label>{t.inventory.itemName} *</label>
                <input
                  type="text"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>{t.inventory.category}</label>
                  <input
                    type="text"
                    className="input"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>{t.inventory.unit} *</label>
                  <input
                    type="text"
                    className="input"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>{t.inventory.quantity} *</label>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    className="input"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>{t.inventory.minStock}</label>
                  <input
                    type="number"
                    min={0}
                    step="0.5"
                    className="input"
                    value={minStock}
                    onChange={(e) => setMinStock(e.target.value)}
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>{t.inventory.purchasePrice} (₸)</label>
                  <input
                    type="number"
                    min={0}
                    className="input"
                    value={purchasePrice}
                    onChange={(e) => setPurchasePrice(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>{t.inventory.expirationDate}</label>
                  <input
                    type="date"
                    className="input"
                    value={expDate}
                    onChange={(e) => setExpDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowAddItem(false)}
                >
                  {t.patients.cancelBtn}
                </button>
                <button type="submit" className="btn btn-primary">
                  {t.patients.saveBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stock Transaction Modal (Incoming / Usage / Write-off) */}
      {txItem && (
        <div className="modal-backdrop" onClick={() => setTxItem(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3>
                  {txType === 'incoming'
                    ? t.inventory.incoming
                    : txType === 'usage'
                    ? t.inventory.usage
                    : t.inventory.writeOff}
                </h3>
                <div className="muted">{txItem.name}</div>
              </div>
              <button className="btn-icon" onClick={() => setTxItem(null)}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleRecordTransaction} className="form-stack">
              {error && <div className="alert alert-error">{error}</div>}
              <div className="form-group">
                <label>Количество ({txItem.unit}) *</label>
                <input
                  type="number"
                  min={0.1}
                  step="0.5"
                  className="input"
                  value={txQty}
                  onChange={(e) => setTxQty(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t.visit.comments}</label>
                <input
                  type="text"
                  className="input"
                  value={txComment}
                  onChange={(e) => setTxComment(e.target.value)}
                />
              </div>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setTxItem(null)}
                >
                  {t.patients.cancelBtn}
                </button>
                <button type="submit" className="btn btn-primary">
                  {t.patients.saveBtn}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
