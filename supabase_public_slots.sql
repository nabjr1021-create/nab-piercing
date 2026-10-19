-- Restituisce solo gli intervalli occupati, senza dati personali.
CREATE OR REPLACE FUNCTION public.get_public_booked_slots(
  p_location_id uuid,
  p_date date
)
RETURNS TABLE(starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT b.starts_at, b.ends_at
  FROM public.bookings AS b
  WHERE b.location_id = p_location_id
    AND b.status = 'confirmed'
    AND b.starts_at < ((p_date + 1)::timestamp AT TIME ZONE 'Europe/Zurich')
    AND b.ends_at > (p_date::timestamp AT TIME ZONE 'Europe/Zurich');
$$;
REVOKE ALL ON FUNCTION public.get_public_booked_slots(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_booked_slots(uuid, date) TO anon, authenticated;
