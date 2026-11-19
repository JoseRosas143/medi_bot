# Benson · J R Dental

Bot de recepción para WhatsApp. Next.js recibe mensajes de Meta, Supabase guarda el catálogo y el estado de las conversaciones, y Google Calendar administra las citas.

## Configuración

1. Usa Node.js 24 y ejecuta `npm ci`. Usa [.env.example](.env.example) como guía para las variables locales y las de Vercel.
2. Configura `WHATSAPP_APP_SECRET` con el secreto de la app de Meta que firmó el webhook. Conserva el token de verificación existente. En Meta, suscribe el evento `messages` a `/api/webhook/whatsapp`.
3. En un Supabase nuevo, aplica [el esquema base](supabase/schema.sql) seguido de [las migraciones](supabase/migrations/) en orden. En una base existente, consulta el historial antes de aplicar migraciones. El bot usa la clave de servidor. Los roles públicos no tienen acceso a estas tablas.
4. Usa una cuenta de servicio con permiso para hacer cambios en Google Calendar. El horario de reserva predeterminado es de 09:00 a 19:00 y cada cita dura 45 minutos. Los bloqueos, cierres y días de descanso se respetan cuando están marcados como ocupados en Calendar.
5. Despliega en Vercel y verifica que `CRON_SECRET` esté definido. Vercel Hobby ejecuta el cron una vez al día entre las 12:00 y las 12:59 de Ciudad de México. La tanda cubre todas las citas de mañana en el calendario de la clínica.

Los eventos creados por Benson guardan el teléfono de WhatsApp como propiedad privada `patientPhone`. Para enviar avisos sobre eventos creados manualmente, asocia esa misma propiedad al evento con el número validado. El bot omite eventos de día completo, cancelados o sin teléfono para los avisos.

## Plantillas de utilidad de Meta

El token usado para administrarlas necesita `whatsapp_business_management` en la WABA correcta. El script consulta primero las plantillas existentes y evita volver a crearlas.

```powershell
node --env-file=.env.local scripts/meta-templates.mjs
node --env-file=.env.local scripts/meta-templates.mjs --submit
```

- `cita_recordatorio` y `cita_cancelada_clinica` usan `es_MX` y tres variables, en este orden: nombre, clínica y fecha/hora.
- Con `--handoff` también puedes solicitar `atencion_pendiente_clinica`, que avisa al equipo cuando su ventana de WhatsApp está cerrada y usa solo el nombre de la clínica.
- Una vez aprobadas, coloca sus nombres en `WHATSAPP_REMINDER_TEMPLATE`, `WHATSAPP_CANCELLATION_TEMPLATE` y, si se crea, `WHATSAPP_HANDOFF_TEMPLATE`. Despliega con esas variables.

Supabase registra el resultado de cada intento en `appointment_notices`. Una solicitud aceptada por Meta es distinta de una entrega, que se registra al recibir la confirmación por webhook. Los intentos con resultado incierto requieren cotejo en Meta antes de reenviar.

## Verificación

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Con números de prueba, escribe «Hola», completa el nombre, abre Tratamientos y Preguntas frecuentes, y envía una nota de voz. Desde el número administrador, escribe «Ayuda», revisa la agenda y responde citando el aviso de atención humana. Reserva una cita de prueba para mañana y comprueba el recordatorio, la cancelación con el botón y el aviso al paciente. Comprueba el estado del aviso en Supabase.
