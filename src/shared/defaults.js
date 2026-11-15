// Shared defaults. Loaded in every context (content script,
// service worker, offscreen document, options page).
(() => {
  const SAF = (globalThis.SAF = globalThis.SAF || {});

  SAF.ROOMS = [
    ['auto', 'Auto-detect room'],
    ['living room', 'Living room'],
    ['bedroom', 'Bedroom'],
    ['primary bedroom', 'Primary bedroom'],
    ['dining room', 'Dining room'],
    ['kitchen', 'Kitchen'],
    ['home office', 'Home office'],
    ['bathroom', 'Bathroom'],
    ['studio apartment', 'Studio'],
    ['entryway', 'Entryway'],
    ['patio or balcony', 'Patio / balcony'],
    ['basement or bonus room', 'Basement / bonus room'],
  ];

  SAF.STYLES = [
    ['modern', 'Modern'],
    ['Scandinavian', 'Scandinavian'],
    ['mid-century modern', 'Mid-century modern'],
    ['transitional', 'Transitional'],
    ['modern farmhouse', 'Modern farmhouse'],
    ['coastal', 'Coastal'],
    ['industrial', 'Industrial'],
    ['traditional', 'Traditional'],
  ];

  SAF.DEFAULTS = {
    // Account: staging runs through the UnitStager server on credits.
    serverUrl: 'https://unitstager.com',
    session: null, // {access_token, refresh_token, expires_at, email} once signed in
    credits: null, // last known balance
    autoPack: null, // pack id bought automatically when credits run low (null = off)
    maxInputEdge: 2048,
    concurrency: 2,
    // Staging
    style: 'modern',
    // Behaviour
    stageUploads: false,
    reviewBeforeUpload: true,
    autoReplace: false,
    backupOriginal: true,
    disclosureLabel: false,
    disclosureText: 'Virtually staged',
    // AppFolio page integration (blank selector = auto-detect)
    pagePattern: '/(properties|units)\\b',
    photoSelector: '',
    uploadInputSelector: '',
    deleteSelector: '',
    minPhotoSize: 100,
  };

  // Stored settings over defaults.
  SAF.merge = (stored) => ({ ...SAF.DEFAULTS, ...stored });
})();
