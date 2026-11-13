// The staging prompt. Kept on the server so every customer gets the same,
// current prompt and it can be tuned without shipping a new extension.
// (The extension has its own copy in src/shared/defaults.js, used only in
// "own API key" mode.)

export const DEFAULT_PROMPT = [
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

export const ROOMS = ['auto', 'living room', 'bedroom', 'primary bedroom', 'dining room', 'kitchen', 'home office', 'bathroom', 'studio apartment', 'entryway', 'patio or balcony', 'basement or bonus room'];

export const STYLES = ['modern', 'Scandinavian', 'mid-century modern', 'transitional', 'modern farmhouse', 'coastal', 'industrial', 'traditional'];

export function buildPrompt({ room, style, custom }) {
  const r = ROOMS.includes(room) && room !== 'auto' ? room : 'room (work out what kind of room it is from the photo)';
  const s = STYLES.includes(style) ? style : 'modern';
  let prompt = DEFAULT_PROMPT.replaceAll('{room}', r).replaceAll('{style}', s);
  const extra = String(custom || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (extra) {
    prompt +=
      '\n\nSpecific instructions for this photo (these take priority over the style guidance ' +
      'above, but never alter the structure of the room): ' +
      extra;
  }
  return prompt;
}
