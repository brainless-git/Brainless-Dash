"""Minimal SNMP v2c client (pure stdlib, UDP) for interface monitoring."""
import logging
import socket

log = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 1.5

# ---- BER encoding ----------------------------------------------------------------

def _enc_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    if n < 0x100:
        return bytes([0x81, n])
    return bytes([0x82, n >> 8, n & 0xff])


def _enc_int(n: int) -> bytes:
    """Encode a non-negative integer (BER Integer, tag 0x02)."""
    if n == 0:
        return b'\x02\x01\x00'
    out: list[int] = []
    v = n
    while v:
        out.append(v & 0xff)
        v >>= 8
    if out[-1] & 0x80:   # prevent sign-bit misread
        out.append(0)
    out.reverse()
    return b'\x02' + _enc_len(len(out)) + bytes(out)


def _enc_str(b: bytes) -> bytes:
    return b'\x04' + _enc_len(len(b)) + b


def _enc_oid(oid: str) -> bytes:
    parts = [int(x) for x in oid.strip('.').split('.')]
    body: list[int] = []
    for v in [parts[0] * 40 + parts[1]] + parts[2:]:
        chunk = [v & 0x7f]
        v >>= 7
        while v:
            chunk.append((v & 0x7f) | 0x80)
            v >>= 7
        body.extend(reversed(chunk))
    return b'\x06' + _enc_len(len(body)) + bytes(body)


def _enc_seq(tag: int, data: bytes) -> bytes:
    return bytes([tag]) + _enc_len(len(data)) + data


# ---- BER decoding ----------------------------------------------------------------

def _dec_len(buf: bytes, pos: int) -> tuple[int, int]:
    b = buf[pos]; pos += 1
    if b < 0x80:
        return b, pos
    n = b & 0x7f
    return int.from_bytes(buf[pos:pos + n], 'big'), pos + n


def _dec_tlv(buf: bytes, pos: int) -> tuple[int, bytes, int]:
    tag = buf[pos]; pos += 1
    length, pos = _dec_len(buf, pos)
    return tag, buf[pos:pos + length], pos + length


def _dec_int(data: bytes) -> int:
    if not data:
        return 0
    neg = data[0] & 0x80
    v = int.from_bytes(data, 'big')
    return v - (1 << (8 * len(data))) if neg else v


def _dec_oid(data: bytes) -> str:
    if not data:
        return ''
    parts = [data[0] // 40, data[0] % 40]
    i = 1
    while i < len(data):
        v = 0
        while i < len(data):
            b = data[i]; i += 1
            v = (v << 7) | (b & 0x7f)
            if not (b & 0x80):
                break
        parts.append(v)
    return '.' + '.'.join(str(p) for p in parts)


def _dec_varbinds(data: bytes) -> list[tuple[str, object]]:
    results: list[tuple[str, object]] = []
    pos = 0
    while pos < len(data):
        try:
            _, vb, pos = _dec_tlv(data, pos)
            _, oid_data, inner = _dec_tlv(vb, 0)
            val_tag, val_data, _ = _dec_tlv(vb, inner)
        except Exception:
            break
        oid = _dec_oid(oid_data)
        if val_tag == 0x02:                          # Integer
            val = _dec_int(val_data)
        elif val_tag == 0x04:                        # OctetString
            val = val_data.decode('utf-8', errors='replace').strip('\x00')
        elif val_tag == 0x06:                        # OID
            val = _dec_oid(val_data)
        elif val_tag in (0x41, 0x42, 0x43, 0x47):  # Counter32/Gauge32/TimeTicks/UInt32
            val = int.from_bytes(val_data, 'big')
        elif val_tag == 0x46:                        # Counter64
            val = int.from_bytes(val_data, 'big')
        elif val_tag in (0x80, 0x81, 0x82):         # noSuchObject/noSuchInstance/endOfMibView
            val = None
        else:
            val = val_data
        results.append((oid, val))
    return results


# ---- Packet builders -------------------------------------------------------------

def _build_get(community: str, oids: list, req_id: int = 1) -> bytes:
    null = b'\x05\x00'
    vbl = b''.join(_enc_seq(0x30, _enc_oid(o) + null) for o in oids)
    pdu = _enc_int(req_id) + _enc_int(0) + _enc_int(0) + _enc_seq(0x30, vbl)
    msg = _enc_int(1) + _enc_str(community.encode()) + _enc_seq(0xa0, pdu)
    return _enc_seq(0x30, msg)


def _build_getbulk(community: str, oids: list, non_reps: int = 0, max_reps: int = 50, req_id: int = 1) -> bytes:
    null = b'\x05\x00'
    vbl = b''.join(_enc_seq(0x30, _enc_oid(o) + null) for o in oids)
    pdu = _enc_int(req_id) + _enc_int(non_reps) + _enc_int(max_reps) + _enc_seq(0x30, vbl)
    msg = _enc_int(1) + _enc_str(community.encode()) + _enc_seq(0xa5, pdu)
    return _enc_seq(0x30, msg)


# ---- Transport -------------------------------------------------------------------

def _send(host: str, port: int, packet: bytes, timeout: float) -> bytes | None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (host, port))
        raw, _ = sock.recvfrom(65535)
        return raw
    except (socket.timeout, OSError) as exc:
        log.debug("SNMP %s:%d: %s", host, port, exc)
        return None
    finally:
        sock.close()


def _parse_response(raw: bytes | None) -> list[tuple[str, object]]:
    if not raw:
        return []
    try:
        _, msg_data, _ = _dec_tlv(raw, 0)
        pos = 0
        _, _, pos = _dec_tlv(msg_data, pos)          # version
        _, _, pos = _dec_tlv(msg_data, pos)          # community
        pdu_tag, pdu_data, _ = _dec_tlv(msg_data, pos)
        if pdu_tag != 0xa2:                           # must be GetResponse
            return []
        p = 0
        _, _, p = _dec_tlv(pdu_data, p)              # request-id
        _, err_data, p = _dec_tlv(pdu_data, p)       # error-status
        _, _, p = _dec_tlv(pdu_data, p)              # error-index
        if _dec_int(err_data) != 0:
            return []
        _, vbl_data, _ = _dec_tlv(pdu_data, p)       # VarBindList
        return _dec_varbinds(vbl_data)
    except Exception as exc:
        log.debug("SNMP parse: %s", exc)
        return []


# ---- Public helpers --------------------------------------------------------------

def snmp_get(host: str, oids: list, community: str = 'public', port: int = 161,
             timeout: float = _DEFAULT_TIMEOUT) -> dict:
    """SNMP v2c GET. Returns {oid_str: value} for responding OIDs."""
    raw = _send(host, port, _build_get(community, oids), timeout)
    return {oid: val for oid, val in _parse_response(raw)}


def snmp_getbulk(host: str, oids: list, max_reps: int = 50, community: str = 'public',
                 port: int = 161, timeout: float = _DEFAULT_TIMEOUT) -> list[tuple[str, object]]:
    """SNMP v2c GETBULK. Returns list of (oid_str, value) pairs."""
    raw = _send(host, port, _build_getbulk(community, oids, max_reps=max_reps), timeout)
    return _parse_response(raw)


# ---- Standard OIDs ---------------------------------------------------------------

_OID_SYSUPTIME = '1.3.6.1.2.1.1.3.0'
_OID_SYSNAME   = '1.3.6.1.2.1.1.5.0'
_OID_SYSDESCR  = '1.3.6.1.2.1.1.1.0'

# IF-MIB column OIDs (walk from each to enumerate all interface instances)
_IF_COLS = [
    ('1.3.6.1.2.1.2.2.1.2',    'descr'),    # ifDescr
    ('1.3.6.1.2.1.2.2.1.8',    'oper'),     # ifOperStatus  (1=up)
    ('1.3.6.1.2.1.2.2.1.5',    'speed'),    # ifSpeed (bits/s, 32-bit, max ~4.3 Gbps)
    ('1.3.6.1.2.1.31.1.1.1.6', 'hc_in'),   # ifHCInOctets  (64-bit)
    ('1.3.6.1.2.1.31.1.1.1.10','hc_out'),   # ifHCOutOctets (64-bit)
    ('1.3.6.1.2.1.2.2.1.14',   'in_err'),   # ifInErrors
    ('1.3.6.1.2.1.2.2.1.20',   'out_err'),  # ifOutErrors
]


def poll_device(host: str, community: str = 'public', port: int = 161) -> dict | None:
    """
    Query a device via SNMP v2c. Returns a dict with system info and an interface
    list, or None if the device does not respond (SNMP not enabled / wrong community).
    """
    sysinfo = snmp_get(host, [_OID_SYSUPTIME, _OID_SYSNAME, _OID_SYSDESCR],
                       community=community, port=port)
    if not sysinfo or sysinfo.get(_OID_SYSUPTIME) is None:
        return None

    uptime_cs = sysinfo.get(_OID_SYSUPTIME, 0)
    uptime_s  = int(uptime_cs / 100) if isinstance(uptime_cs, (int, float)) else 0

    # One GETBULK fetches all interface columns in a single UDP round-trip.
    # Varbinds are interleaved: col0.1, col1.1, ..., colN.1, col0.2, col1.2, ...
    col_oids   = [c[0] for c in _IF_COLS]
    col_fields = [c[1] for c in _IF_COLS]
    bulk = snmp_getbulk(host, col_oids, max_reps=60, community=community, port=port)

    ifaces: dict[str, dict] = {}
    for oid, val in bulk:
        if val is None:
            continue
        for col_oid, field in zip(col_oids, col_fields):
            prefix = col_oid + '.'
            if oid.startswith(prefix):
                suffix = oid[len(prefix):]
                if '.' not in suffix:   # simple integer index = same table
                    ifaces.setdefault(suffix, {})[field] = val
                break

    interfaces = []
    for idx_str in sorted(ifaces, key=lambda x: int(x)):
        d = ifaces[idx_str]
        descr = str(d.get('descr') or '').strip('\x00 ')
        if not descr or descr.lower() in ('lo', 'loopback'):
            continue
        interfaces.append({
            'index':     int(idx_str),
            'name':      descr,
            'up':        d.get('oper') == 1,
            'speed_bps': int(d.get('speed') or 0),
            'in_bytes':  int(d.get('hc_in') or 0),
            'out_bytes': int(d.get('hc_out') or 0),
            'in_err':    int(d.get('in_err') or 0),
            'out_err':   int(d.get('out_err') or 0),
        })

    return {
        'uptime':     uptime_s,
        'sysname':    str(sysinfo.get(_OID_SYSNAME) or '').strip(),
        'sysdescr':   str(sysinfo.get(_OID_SYSDESCR) or '').strip(),
        'interfaces': interfaces,
    }
