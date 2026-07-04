// State Variables
let expirations = [];
let currentFilter = 'all';
let editId = null;

// DOM Elements
const listLoading = document.getElementById('list-loading');
const listEmpty = document.getElementById('list-empty');
const cardsContainer = document.getElementById('cards-container');
const dashboardSearch = document.getElementById('dashboard-search');
const filterTabs = document.querySelectorAll('.filter-tab');

// Stats Elements
const statTotal = document.getElementById('stat-total');
const statExpired = document.getElementById('stat-expired');
const statToday = document.getElementById('stat-today');
const statSoon = document.getElementById('stat-soon');

// Modal Elements
const modal = document.getElementById('modal-add-edit');
const modalTitle = document.getElementById('modal-title');
const btnFab = document.getElementById('fab-add');
const btnModalClose = document.getElementById('btn-modal-close');
const btnCancel = document.getElementById('btn-cancel');
const expirationForm = document.getElementById('expiration-form');

// Form Fields
const formId = document.getElementById('form-id');
const formCode = document.getElementById('form-code');
const btnSearchProduct = document.getElementById('btn-search-product');
const searchStatus = document.getElementById('search-status');
const formTitle = document.getElementById('form-title');
const formExpiry = document.getElementById('form-expiry');
const formPlu = document.getElementById('form-plu');
const formEan = document.getElementById('form-ean');
const formUrl = document.getElementById('form-url');

// Collapsible Elements
const btnToggleManual = document.getElementById('btn-toggle-manual');
const manualContent = document.getElementById('manual-content');

// Notification Permission Button
const btnNotifications = document.getElementById('btn-notifications');
const pulseIndicator = btnNotifications.querySelector('.pulse-indicator');

// Register Service Worker and initialize Push Manager
let swRegistration = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('Service Worker registrado.', reg.scope);
        swRegistration = reg;
        if (Notification.permission === 'granted') {
          subscribeToPush(reg);
        }
      })
      .catch(err => console.error('Fallo registro Service Worker:', err));
  });
}

// Convert VAPID public key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Register Push Subscription
async function subscribeToPush(registration) {
  try {
    const resKey = await fetch('/api/vapid-public-key');
    const { publicKey } = await resKey.json();
    if (!publicKey) return;

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    await fetch('/api/subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(subscription)
    });
    console.log('Suscripción Web Push registrada con éxito.');
  } catch (err) {
    console.error('Error al registrar la suscripción Web Push:', err);
  }
}

// Request Notification Permission on Page Load/Action
async function initNotifications() {
  if (!('Notification' in window)) {
    console.log('Este navegador no soporta notificaciones.');
    return;
  }
  
  updateNotificationButtonState();

  btnNotifications.addEventListener('click', async () => {
    const permission = await Notification.requestPermission();
    updateNotificationButtonState();
    if (permission === 'granted') {
      new Notification('🔔 Alertas Activas', {
        body: 'Notificaciones activas en segundo plano. Recibirás avisos de vencimientos.',
        icon: '/icon.svg'
      });
      if (swRegistration) {
        subscribeToPush(swRegistration);
      }
    }
  });

  // Setup test push event trigger
  const btnTestPush = document.getElementById('btn-test-push');
  btnTestPush.addEventListener('click', async () => {
    if (Notification.permission !== 'granted') {
      showToast('Primero debes habilitar las notificaciones.', 'error');
      return;
    }
    
    showToast('Programando notificación. Cierra la app ahora...', 'success');
    
    try {
      await fetch('/api/test-push', { method: 'POST' });
    } catch (err) {
      console.error('Error triggering test push:', err);
      showToast('Error de red al programar', 'error');
    }
  });
}

function updateNotificationButtonState() {
  if (Notification.permission === 'default') {
    pulseIndicator.classList.remove('hidden');
    btnNotifications.title = 'Activar Notificaciones';
    btnNotifications.querySelector('i').className = 'fa-regular fa-bell';
  } else if (Notification.permission === 'granted') {
    pulseIndicator.classList.add('hidden');
    btnNotifications.title = 'Notificaciones Activadas';
    btnNotifications.querySelector('i').className = 'fa-solid fa-bell';
    btnNotifications.style.color = '#10b981';
  } else {
    pulseIndicator.classList.add('hidden');
    btnNotifications.title = 'Notificaciones Bloqueadas';
    btnNotifications.querySelector('i').className = 'fa-solid fa-bell-slash';
    btnNotifications.style.color = '#ef4444';
  }
}

// App Initialization
document.addEventListener('DOMContentLoaded', () => {
  fetchExpirations();
  initNotifications();
  setupEventListeners();
  
  // Set default minimum date in date picker to today
  const todayStr = new Date().toISOString().split('T')[0];
  formExpiry.min = todayStr;
});

// Event Listeners Setup
function setupEventListeners() {
  // Filter tabs
  filterTabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      filterTabs.forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      currentFilter = e.target.dataset.filter;
      renderExpirations();
    });
  });

  // Search input
  dashboardSearch.addEventListener('input', renderExpirations);

  // FAB Modal Trigger
  btnFab.addEventListener('click', () => openModal());

  // Modal close handlers
  btnModalClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);
  
  // Close modal when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  // Toggle Advanced Manual inputs
  btnToggleManual.addEventListener('click', () => {
    btnToggleManual.classList.toggle('open');
    manualContent.classList.toggle('hidden');
  });

  // Product Search trigger
  btnSearchProduct.addEventListener('click', performProductSearch);
  formCode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      performProductSearch();
    }
  });

  // Form Submit
  expirationForm.addEventListener('submit', handleFormSubmit);
}

// Helper: Calculate Remaining Days
function getRemainingDays(expirationDateStr) {
  // Parse date locally to avoid UTC timezone shift issues
  const [year, month, day] = expirationDateStr.split('-').map(Number);
  const expDate = new Date(year, month - 1, day);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = expDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

// Fetch Expirations from API
async function fetchExpirations() {
  try {
    const res = await fetch('/api/expirations');
    const response = await res.json();
    if (response.success) {
      expirations = response.data;
      renderExpirations();
      checkAndNotify(expirations);
    }
  } catch (err) {
    console.error('Error fetching expirations:', err);
    showToast('Error de red al cargar vencimientos', 'error');
  }
}

// Check expirations and send desktop notifications
function checkAndNotify(items) {
  if (Notification.permission !== 'granted') return;
  
  const todayStr = new Date().toISOString().split('T')[0];
  let notifiedMap = {};
  
  try {
    notifiedMap = JSON.parse(localStorage.getItem('coto_notified_expirations') || '{}');
  } catch (e) {
    notifiedMap = {};
  }
  
  const expiringToday = items.filter(item => {
    const days = getRemainingDays(item.expirationDate);
    return days === 0;
  });
  
  const expiredItems = items.filter(item => {
    const days = getRemainingDays(item.expirationDate);
    return days < 0;
  });

  // Notify today's expirations
  expiringToday.forEach(item => {
    if (notifiedMap[item.id] !== todayStr) {
      new Notification('⚠️ Producto Vence Hoy', {
        body: `"${item.title}" (PLU: ${item.plu || 'N/D'}) vence hoy. Consumir pronto.`,
        icon: '/icon.svg',
        tag: item.id
      });
      notifiedMap[item.id] = todayStr;
    }
  });

  // Notify expired items (remind once if not notified recently)
  expiredItems.forEach(item => {
    const key = `expired-${item.id}`;
    if (notifiedMap[key] !== todayStr) {
      new Notification('🚨 Producto Vencido', {
        body: `"${item.title}" venció el ${formatDisplayDate(item.expirationDate)}.`,
        icon: '/icon.svg',
        tag: item.id
      });
      notifiedMap[key] = todayStr;
    }
  });
  
  localStorage.setItem('coto_notified_expirations', JSON.stringify(notifiedMap));
}

// Helper: Format Date to readable string
function formatDisplayDate(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}/${month}/${year}`;
}

// Filter, Sort, and Render cards
function renderExpirations() {
  listLoading.classList.add('hidden');
  
  if (expirations.length === 0) {
    listEmpty.classList.remove('hidden');
    cardsContainer.classList.add('hidden');
    updateStats();
    return;
  }
  
  listEmpty.classList.add('hidden');
  
  // Sort items: oldest expiration date first (expiring/expired first)
  const sortedItems = [...expirations].sort((a, b) => {
    return new Date(a.expirationDate) - new Date(b.expirationDate);
  });
  
  // Filter by search query
  const query = dashboardSearch.value.trim().toLowerCase();
  const filteredSearch = sortedItems.filter(item => {
    const matchesTitle = item.title.toLowerCase().includes(query);
    const matchesPlu = item.plu.toLowerCase().includes(query);
    const matchesEan = item.ean.toLowerCase().includes(query);
    return matchesTitle || matchesPlu || matchesEan;
  });
  
  // Filter by Tab
  const finalFiltered = filteredSearch.filter(item => {
    const days = getRemainingDays(item.expirationDate);
    if (currentFilter === 'expired') return days < 0;
    if (currentFilter === 'today') return days === 0;
    if (currentFilter === 'soon') return days > 0 && days <= 7;
    if (currentFilter === 'safe') return days > 7;
    return true; // 'all'
  });
  
  // Render Cards
  cardsContainer.innerHTML = '';
  if (finalFiltered.length === 0) {
    cardsContainer.innerHTML = `<div style="grid-column: 1/-1; padding: 3rem; text-align: center; color: var(--text-secondary);">No se encontraron productos para esta búsqueda/filtro.</div>`;
    cardsContainer.classList.remove('hidden');
  } else {
    finalFiltered.forEach(item => {
      const days = getRemainingDays(item.expirationDate);
      let statusClass = 'status-safe';
      let statusLabel = 'Vigente';
      let countdownLabel = `Vence en ${days} días`;
      let bodyIcon = '<i class="fa-regular fa-circle-check"></i>';
      
      if (days < 0) {
        statusClass = 'status-expired';
        statusLabel = 'Vencido';
        const absoluteDays = Math.abs(days);
        countdownLabel = absoluteDays === 1 ? 'Venció ayer' : `Venció hace ${absoluteDays} días`;
        bodyIcon = '<i class="fa-solid fa-triangle-exclamation"></i>';
      } else if (days === 0) {
        statusClass = 'status-today';
        statusLabel = 'Vence Hoy';
        countdownLabel = '¡Vence hoy!';
        bodyIcon = '<i class="fa-solid fa-hourglass-half"></i>';
      } else if (days <= 7) {
        statusClass = 'status-soon';
        statusLabel = 'Vence Pronto';
        countdownLabel = days === 1 ? 'Vence mañana' : `Vence en ${days} días`;
        bodyIcon = '<i class="fa-regular fa-clock"></i>';
      }
      
      const card = document.createElement('div');
      card.className = `expiry-card ${statusClass}`;
      
      let tagsHtml = '';
      if (item.plu) tagsHtml += `<span class="card-tag plu-tag">PLU: ${item.plu}</span>`;
      if (item.ean && item.ean !== 'No disponible') tagsHtml += `<span class="card-tag ean-tag">EAN: ${item.ean}</span>`;
      
      let cotoLinkHtml = '';
      if (item.url) {
        cotoLinkHtml = `<a href="${item.url}" target="_blank" class="coto-link"><i class="fa-solid fa-up-right-from-square"></i> Ver en Coto</a>`;
      }
      
      card.innerHTML = `
        <div class="card-header">
          <div class="card-title-area">
            <h3 class="card-title">${item.title}</h3>
            <div class="card-tags">${tagsHtml}</div>
          </div>
          <span class="badge-status">${statusLabel}</span>
        </div>
        <div class="card-body">
          <div class="card-body-icon">${bodyIcon}</div>
          <div class="card-date-info">
            <span class="card-date">${formatDisplayDate(item.expirationDate)}</span>
            <span class="card-countdown">${countdownLabel}</span>
          </div>
        </div>
        <div class="card-footer">
          ${cotoLinkHtml}
          <div class="card-actions">
            <button class="btn-card-action btn-edit" title="Editar fecha" onclick="editExpiration('${item.id}')">
              <i class="fa-solid fa-pencil"></i>
            </button>
            <button class="btn-card-action btn-delete" title="Eliminar" onclick="deleteExpiration('${item.id}')">
              <i class="fa-regular fa-trash-can"></i>
            </button>
          </div>
        </div>
      `;
      cardsContainer.appendChild(card);
    });
    cardsContainer.classList.remove('hidden');
  }
  
  updateStats();
}

// Update Header Statistics
function updateStats() {
  let total = expirations.length;
  let expired = 0;
  let today = 0;
  let soon = 0;
  
  expirations.forEach(item => {
    const days = getRemainingDays(item.expirationDate);
    if (days < 0) expired++;
    else if (days === 0) today++;
    else if (days <= 7) soon++;
  });
  
  statTotal.textContent = total;
  statExpired.textContent = expired;
  statToday.textContent = today;
  statSoon.textContent = soon;
}

// Product search handler
async function performProductSearch() {
  const query = formCode.value.trim();
  if (!query) {
    searchStatus.className = 'search-status error';
    searchStatus.innerHTML = '<i class="fa-solid fa-xmark"></i> Ingresa un código PLU o EAN.';
    return;
  }
  
  searchStatus.className = 'search-status loading';
  searchStatus.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Buscando producto en Coto...';
  btnSearchProduct.disabled = true;
  
  try {
    const res = await fetch(`/api/search?plu=${encodeURIComponent(query)}`);
    const data = await res.json();
    btnSearchProduct.disabled = false;
    
    if (data.success) {
      formTitle.value = data.title;
      formPlu.value = data.plu !== 'No disponible' ? data.plu : '';
      formEan.value = data.ean !== 'No disponible' ? data.ean : '';
      formUrl.value = data.url || '';
      
      searchStatus.className = 'search-status success';
      searchStatus.innerHTML = `<i class="fa-solid fa-check"></i> Encontrado: ${data.title.substring(0, 30)}...`;
      
      showToast('Producto encontrado con éxito!', 'success');
    } else {
      throw new Error(data.error || 'Producto no encontrado');
    }
  } catch (err) {
    console.error('Error searching product:', err);
    btnSearchProduct.disabled = false;
    searchStatus.className = 'search-status error';
    searchStatus.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> No encontrado. Cárgalo de forma manual.';
    
    // Auto-expand advanced options so they can write title, plu, etc.
    btnToggleManual.classList.add('open');
    manualContent.classList.remove('hidden');
    
    // Autofill manual code fields
    if (/^\d+$/.test(query)) {
      if (query.length <= 8) {
        formPlu.value = query;
      } else {
        formEan.value = query;
      }
    }
    
    formTitle.focus();
  }
}

// Handle Expirations Form Submit
async function handleFormSubmit(e) {
  e.preventDefault();
  
  const id = formId.value || null;
  const title = formTitle.value.trim();
  const expirationDate = formExpiry.value;
  const code = formCode.value.trim();
  
  // Decide PLU/EAN mapping based on user inputs
  let plu = formPlu.value.trim();
  let ean = formEan.value.trim();
  
  if (!plu && !ean && code) {
    if (/^\d+$/.test(code)) {
      if (code.length <= 8) plu = code;
      else ean = code;
    } else {
      plu = code;
    }
  }
  
  const url = formUrl.value.trim() || null;
  
  if (!title || !expirationDate) {
    showToast('Por favor completa el título y la fecha de vencimiento', 'error');
    return;
  }
  
  const payload = { id, plu, ean, title, expirationDate, url };
  
  try {
    const res = await fetch('/api/expirations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    const result = await res.json();
    
    if (result.success) {
      showToast(id ? 'Vencimiento actualizado' : 'Producto agregado al seguimiento', 'success');
      
      // If manually registered and we have PLU/EAN, let's also register it in local product cache
      if (plu && title) {
        fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plu, title, ean, url })
        }).catch(err => console.log('Error local product registration:', err));
      }
      
      closeModal();
      fetchExpirations();
    } else {
      showToast(result.error || 'Ocurrió un error al guardar', 'error');
    }
  } catch (err) {
    console.error('Error saving expiration:', err);
    showToast('Error de red al guardar el registro', 'error');
  }
}

// Open modal for adding/editing
function openModal(item = null) {
  expirationForm.reset();
  searchStatus.innerHTML = '';
  searchStatus.className = 'search-status';
  btnSearchProduct.disabled = false;
  
  btnToggleManual.classList.remove('open');
  manualContent.classList.add('hidden');
  
  if (item) {
    // Edit Mode
    editId = item.id;
    formId.value = item.id;
    formTitle.value = item.title;
    formExpiry.value = item.expirationDate;
    
    formCode.value = item.plu || item.ean || '';
    formPlu.value = item.plu || '';
    formEan.value = item.ean || '';
    formUrl.value = item.url || '';
    
    modalTitle.textContent = 'Editar Vencimiento';
    
    // Expand advanced values if editing, to show full details
    btnToggleManual.classList.add('open');
    manualContent.classList.remove('hidden');
  } else {
    // Add Mode
    editId = null;
    formId.value = '';
    modalTitle.textContent = 'Agregar Vencimiento';
  }
  
  modal.classList.remove('hidden');
  formCode.focus();
}

// Close Modal
function closeModal() {
  modal.classList.add('hidden');
  editId = null;
  expirationForm.reset();
}

// Edit item trigger
function editExpiration(id) {
  const item = expirations.find(e => e.id === id);
  if (item) {
    openModal(item);
  }
}

// Delete expiration tracking
async function deleteExpiration(id) {
  const item = expirations.find(e => e.id === id);
  if (!item) return;
  
  if (confirm(`¿Estás seguro que deseas eliminar "${item.title}" de tu lista?`)) {
    try {
      const res = await fetch(`/api/expirations/${id}`, {
        method: 'DELETE'
      });
      const result = await res.json();
      if (result.success) {
        showToast('Vencimiento eliminado', 'success');
        fetchExpirations();
      } else {
        showToast(result.error || 'No se pudo eliminar el registro', 'error');
      }
    } catch (err) {
      console.error('Error deleting:', err);
      showToast('Error de red al eliminar', 'error');
    }
  }
}

// Toast Notification Helper
function showToast(message, type = 'success') {
  // Check if a toast container exists, create one if not
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.position = 'fixed';
    container.style.bottom = '2rem';
    container.style.left = '50%';
    container.style.transform = 'translateX(-50%)';
    container.style.zIndex = '999';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '0.5rem';
    container.style.pointerEvents = 'none';
    document.body.appendChild(container);
  }
  
  const toast = document.createElement('div');
  toast.style.background = 'rgba(30, 41, 59, 0.95)';
  toast.style.color = '#fff';
  toast.style.padding = '0.75rem 1.5rem';
  toast.style.borderRadius = '30px';
  toast.style.fontFamily = 'var(--font-main)';
  toast.style.fontSize = '0.85rem';
  toast.style.fontWeight = '700';
  toast.style.boxShadow = 'var(--shadow-md)';
  toast.style.backdropFilter = 'blur(10px)';
  toast.style.pointerEvents = 'auto';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(20px)';
  toast.style.transition = 'all var(--transition-normal)';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '0.5rem';
  
  let icon = '<i class="fa-solid fa-circle-check" style="color: var(--color-safe);"></i>';
  if (type === 'error') {
    icon = '<i class="fa-solid fa-circle-exclamation" style="color: var(--color-expired);"></i>';
    toast.style.border = '1px solid rgba(239, 68, 68, 0.2)';
  } else {
    toast.style.border = '1px solid rgba(16, 185, 129, 0.2)';
  }
  
  toast.innerHTML = `${icon} <span>${message}</span>`;
  container.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 10);
  
  // Remove toast
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}
