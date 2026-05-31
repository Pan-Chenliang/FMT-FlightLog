# FMT MLog Format Reference

Use this reference when implementing or debugging the browser-side parser.

## Constants

Source in firmware:

- `D:\AEROlab\Project\FMT\FMT-Firmware\src\module\log\mlog.h`
- Python parser reference:
  `D:\AEROlab\Project\FMT\FMT-Firmware\utils\python_mlog_parser\parse_mlog.py`
- MATLAB parser reference:
  `D:\AEROlab\Project\FMT\FMT-Model\utils\log_parser\functions\mlog_parser.m`

Known constants:

| Name | Value |
| --- | --- |
| `MLOG_VERSION` | `2` |
| `MLOG_BEGIN_MSG1` | `0x92` |
| `MLOG_BEGIN_MSG2` | `0x05` |
| `MLOG_END_MSG` | `0x26` |
| `MLOG_MAX_NAME_LEN` | `25` |
| `MLOG_DESCRIPTION_SIZE` | `128` |
| `MLOG_MODEL_INFO_SIZE` | `256` |

## Header Layout

All numeric fields are little-endian.

| Field | Type | Notes |
| --- | --- | --- |
| `version` | `uint16` | Expected current value is `2`. |
| `timestamp` | `uint32` | Log header timestamp. |
| `max_name_len` | `uint16` | Fixed byte length for bus, element, group, and parameter names. Usually `25`. |
| `max_desc_len` | `uint16` | Description byte length. Usually `128`. |
| `max_model_info_len` | `uint16` | Model info byte length. Usually `256`. |
| `description` | `char[max_desc_len]` | UTF-8 fixed string, null terminated when shorter. |
| `model_info` | `char[max_model_info_len]` | UTF-8 fixed string, null terminated when shorter. |
| `num_bus` | `uint8` | Number of bus definitions following. |

Each bus definition:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `char[max_name_len]` | Bus/message name. |
| `msg_id` | `uint8` | Message id used in frames. |
| `num_elem` | `uint8` | Number of element definitions. |

Each element definition:

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `char[max_name_len]` | Field name. |
| `type` | `uint16` | See element types. |
| `number` | `uint16` | Scalar when `1`, vector when greater than `1`. |

Parameter section follows bus definitions:

| Field | Type | Notes |
| --- | --- | --- |
| `num_param_group` | `uint8` | Number of parameter groups. |
| `group.name` | `char[max_name_len]` | Repeated per group. |
| `group.param_num` | `uint32` | Repeated per group. MATLAB parser and `param_group_t` define this as 4 bytes. |
| `param.name` | `char[max_name_len]` | Repeated per parameter. |
| `param.type` | `uint8` | See parameter types. |
| `param.value` | typed | Size and reader depend on `param.type`. |

## Element Types

| ID | Name | Size | JavaScript reader |
| --- | --- | --- | --- |
| `0` | `INT8` | 1 | `DataView.getInt8` |
| `1` | `UINT8` | 1 | `DataView.getUint8` |
| `2` | `INT16` | 2 | `DataView.getInt16(offset, true)` |
| `3` | `UINT16` | 2 | `DataView.getUint16(offset, true)` |
| `4` | `INT32` | 4 | `DataView.getInt32(offset, true)` |
| `5` | `UINT32` | 4 | `DataView.getUint32(offset, true)` |
| `6` | `FLOAT` | 4 | `DataView.getFloat32(offset, true)` |
| `7` | `DOUBLE` | 8 | `DataView.getFloat64(offset, true)` |
| `8` | `BOOLEAN` | 1 | `DataView.getUint8(offset) !== 0` |

Parameter types currently use IDs `0` through `7` with the same sizes as above. Some custom logs may contain parameter type IDs outside this range or parameter sections that do not match the default layout. Do not fail the whole log for this. Stop parameter decoding, keep a warning, and start frame scanning from the parameter section start.

## Frame Layout

Frames begin after the full header and parameter section.

```text
[0x92][0x05][msg_id][payload bytes derived from bus definition][0x26]
```

Parsing algorithm:

1. Scan for `0x92 0x05`.
2. Read `msg_id`.
3. Find the bus definition for `msg_id`.
4. Compute payload length from the bus element definitions.
5. Verify the byte after payload is `0x26`.
6. Decode payload fields in element order.
7. Advance to the next byte after the end marker.
8. On mismatch or unknown id, advance by one byte and scan again.

## Payload Decoding

For each bus element:

- Look up type size and reader from element type.
- Read `number` values.
- Scalar field name is `name`.
- Vector field names are `name[0]`, `name[1]`, etc.

Payload size is:

```text
sum(type_size(element.type) * element.number)
```

## Timestamp and `delta_ts`

If a bus has a scalar field named exactly `timestamp`, compute `delta_ts` per `msg_id`.

```text
delta_ts = current_timestamp - previous_timestamp_for_same_msg_id
```

The Python parser treats the timestamp as a 32-bit unsigned value for rollover behavior. Browser code should preserve equivalent unsigned behavior where practical.

If no timestamp field exists, keep `delta_ts = 0`.

## CSV Output

CSV header order:

1. Fields expanded from bus elements in header order.
2. Final `delta_ts` column.

Generate one CSV per bus with frames:

```text
mlog_msg_<msg_id>_<bus_name>.csv
```

## Chart Selection Heuristic

For the minimal viewer:

1. Skip buses with fewer than two frames.
2. Use `timestamp` as x-axis when present; otherwise use frame index.
3. Consider numeric fields except `timestamp` and `delta_ts`.
4. Skip fields that never change.
5. Draw the first several valid series as quick-look charts.
