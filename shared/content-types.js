// Metadata shared by the editor and the server. No vendor services are required.
export const CONTENT_TYPES = [
  { id: 'url', name: 'URL / Link', icon: 'Link2', description: 'Send people to any website.', fields: [] },
  { id: 'pdf', name: 'PDF', icon: 'FileText', description: 'Upload a PDF. Replace it without reprinting.', mode: 'dynamic', file: true, accept: '.pdf,application/pdf', maxMB: 20 },
  { id: 'image', name: 'Image', icon: 'Image', description: 'Share a photo, poster, or artwork.', mode: 'dynamic', file: true, accept: 'image/png,image/jpeg,image/webp', maxMB: 10 },
  { id: 'app', name: 'Play Market / App Store', icon: 'Smartphone', description: 'One code. The right store for each device.', mode: 'dynamic', fields: [['androidUrl', 'Google Play URL', 'url'], ['iosUrl', 'App Store URL', 'url'], ['fallbackUrl', 'Default website URL', 'url']] },
  { id: 'text', name: 'Text', icon: 'Type', description: 'Put a message directly inside your code.', mode: 'static', fields: [] },
  { id: 'whatsapp', name: 'WhatsApp', icon: 'MessageCircle', description: 'Start a chat with a prepared message.', fields: [['phone', 'WhatsApp number', 'tel'], ['message', 'Message (optional)', 'textarea']] },
  { id: 'youtube', name: 'YouTube', icon: 'Play', description: 'Share a video, channel, or playlist.', fields: [['url', 'YouTube URL', 'url']] },
  { id: 'instagram', name: 'Instagram', icon: 'Camera', description: 'Connect to your profile or a post.', fields: [['url', 'Instagram URL', 'url']] },
  { id: 'facebook', name: 'Facebook', icon: 'Users', description: 'Share your page, profile, or event.', fields: [['url', 'Facebook URL', 'url']] },
  { id: 'telegram', name: 'Telegram', icon: 'Send', description: 'Open your Telegram profile or channel.', fields: [['username', 'Telegram username', 'text']] },
  { id: 'vcard', name: 'vCard', icon: 'ContactRound', description: 'Save your contact details to a phone.', mode: 'static', fields: [['firstName', 'First name', 'text'], ['lastName', 'Last name (optional)', 'text'], ['organization', 'Organization (optional)', 'text'], ['phone', 'Phone number (optional)', 'tel'], ['email', 'Email address (optional)', 'email'], ['website', 'Website (optional)', 'url'], ['address', 'Address (optional)', 'text']] },
  { id: 'map', name: 'Map', icon: 'MapPin', description: 'Help people find an address or place.', fields: [['address', 'Address or coordinates', 'text']] },
  { id: 'wifi', name: 'Wi-Fi', icon: 'Wifi', description: 'Join your network with a scan.', mode: 'static', fields: [['ssid', 'Network name (SSID)', 'text'], ['security', 'Security', 'security'], ['password', 'Wi-Fi password', 'password'], ['hidden', 'Hidden network', 'checkbox']] },
  { id: 'audio', name: 'Audio', icon: 'Music2', description: 'Share an MP3, WAV, or Ogg recording.', mode: 'dynamic', file: true, accept: '.mp3,.wav,.ogg,audio/mpeg,audio/wav,audio/ogg', maxMB: 25 },
  { id: 'email', name: 'E-mail', icon: 'Mail', description: 'Compose an email with a subject and message.', mode: 'static', fields: [['email', 'Recipient email', 'email'], ['subject', 'Subject (optional)', 'text'], ['body', 'Email message (optional)', 'textarea']] },
  { id: 'booking', name: 'Booking', icon: 'CalendarCheck', description: 'Open your booking or appointment page.', fields: [['url', 'Booking page URL', 'url']] },
  { id: 'phone', name: 'Phone Call', icon: 'Phone', description: 'Open the dialer with your number.', mode: 'static', fields: [['phone', 'Phone number', 'tel']] },
  { id: 'pptx', name: 'PPTX', icon: 'Presentation', description: 'Upload a presentation for people to download.', mode: 'dynamic', file: true, accept: '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation', maxMB: 20 },
  { id: 'smart', name: 'Smart QR Code', icon: 'Route', description: 'Route iOS, Android, and other devices differently.', mode: 'dynamic', fields: [['fallbackUrl', 'Default destination URL', 'url'], ['iosUrl', 'iOS destination URL (optional)', 'url'], ['androidUrl', 'Android destination URL (optional)', 'url']] },
];
export const contentType = id => CONTENT_TYPES.find(type => type.id === id);
