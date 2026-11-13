// Shared defaults + prompt building. Loaded in every context (content script,
// service worker, offscreen document, options page).
(() => {
  const SAF = (globalThis.SAF = globalThis.SAF || {});

  SAF.DEFAULT_PROMPT = [
    'Virtually stage this real estate listing photo of a {room}.',
    'Furnish it with realistic, tasteful {style} furniture and decor that suits the space,',
    'correctly scaled, with natural contact shadows and lighting that matches the scene.',
    '',
    'This must remain a truthful photo of the same room.',
    'Keep the camera angle, framing and perspective identical.',
    'Do not change, move, add or remove any walls, windows, doors, flooring, ceilings, trim,',
    'cabinetry, counters, appliances, fixtures, outlets, vents, or the view through the windows.',
    'Do not repaint, re-floor or renovate. Do not hide damage or defects.',
    'Do not block doorways, windows, closets or built-ins with furniture.',
    'No people, pets, text, logos or watermarks.',
    'The result should look like a professional, photorealistic listing photo.',
  ].join('\n');

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
    // How photos get staged: 'account' = UnitStager account with credits
    // (through the UnitStager server); 'own-key' = straight to the image
    // service with the user's own API key.
    mode: 'account',
    serverUrl: 'https://unitstager.com',
    session: null, // {access_token, refresh_token, expires_at, email} once signed in
    credits: null, // last known balance
    // Image model (own-key mode only)
    apiKey: '',
    apiBase: 'https://api.openai.com/v1',
    model: 'gpt-image-2',
    quality: 'high',
    inputFidelity: 'high',
    maxInputEdge: 2048,
    concurrency: 2,
    // Staging
    style: 'modern',
    basePrompt: SAF.DEFAULT_PROMPT,
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

  // Stored settings over defaults. Installs that already had an API key from
  // before accounts existed keep working in own-key mode.
  SAF.merge = (stored) => {
    const s = { ...SAF.DEFAULTS, ...stored };
    if (!stored.mode && stored.apiKey) s.mode = 'own-key';
    return s;
  };

  SAF.buildPrompt = ({ basePrompt, room, style, custom }) => {
    const roomText =
      !room || room === 'auto' ? 'room (work out what kind of room it is from the photo)' : room;
    let prompt = (basePrompt || SAF.DEFAULT_PROMPT)
      .replaceAll('{room}', roomText)
      .replaceAll('{style}', style || 'modern');
    if (custom && custom.trim()) {
      prompt +=
        '\n\nSpecific instructions for this photo (these take priority over the style guidance ' +
        'above, but never alter the structure of the room): ' +
        custom.trim();
    }
    return prompt;
  };
})();
