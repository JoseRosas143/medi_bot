import { clinicName } from '@/lib/clinic-time';

const arrivalReference = 'https://maps.app.goo.gl/15xyVp2bi89p6Lrs5?g_st=ac';

export async function formatVisitLocation() {
  return `📍 *Referencia de llegada · ${await clinicName()}*\nGoogle Maps (Street View)\n${arrivalReference}`;
}
