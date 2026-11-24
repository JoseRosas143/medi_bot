import { clinicName } from '@/lib/clinic-time';
import { normalized } from '@/lib/menus';
import { supabaseAdmin as db } from '@/lib/supabase';
import { sendWhatsAppInteractiveButtons, sendWhatsAppText } from '@/lib/whatsapp';

export async function askReminderPreference(phone: string) {
  await sendWhatsAppInteractiveButtons({ to: phone,
    bodyText: `¿Aceptas recibir recordatorios de tus citas de ${await clinicName()} por WhatsApp? Puedes cambiarlo desde «Recordatorios» en el menú.`,
    buttons: [
      { id: 'reminders_accept', title: 'Sí, acepto' },
      { id: 'reminders_decline', title: 'No, gracias' },
    ],
  });
}

export async function handleReminderPreference(phone: string, content: string, option: string | undefined, inboundAt: string) {
  const text = normalized(content);
  if (option === 'reminders_settings' || (!option && text === 'recordatorios')) {
    await askReminderPreference(phone);
    return true;
  }
  if (option !== 'reminders_accept' && option !== 'reminders_decline' && (option || text !== 'no quiero recordatorios')) return false;
  const accepted = option === 'reminders_accept';
  const { data } = await db.from('patients').update({
    reminder_whatsapp_allowed: accepted, reminder_whatsapp_responded_at: inboundAt,
  }).eq('phone', phone).or(`reminder_whatsapp_responded_at.is.null,reminder_whatsapp_responded_at.lte.${inboundAt}`)
    .select('phone').maybeSingle().throwOnError();
  await sendWhatsAppText(phone, !data ? 'Ya guardé una respuesta más reciente. Puedes revisar tu preferencia en «Recordatorios».'
    : accepted ? '✅ Guardé tu permiso para recibir recordatorios de citas por WhatsApp.'
      : 'Guardé tu preferencia. Tu cita se conserva y no recibirás recordatorios por WhatsApp.');
  return true;
}
