# Load cell (HX711) snippet for the ESP32 bin

Untested sketch. Add to the existing firmware that builds the telemetry JSON; the backend already accepts an optional `weightG` field (grams, whole bin including tare).

```cpp
#include "HX711.h"
HX711 scale;
const int HX_DOUT = 16, HX_SCK = 17;   // choose free pins
const float CAL_FACTOR = 420.0;        // calibrate with a known weight

void setupScale() {
  scale.begin(HX_DOUT, HX_SCK);
  scale.set_scale(CAL_FACTOR);
  scale.tare();                        // empty bin at boot, or store a fixed tare offset
}

float readWeightG() {
  if (!scale.is_ready()) return NAN;
  return scale.get_units(5);           // average of 5 samples
}

// in the telemetry builder, before serializing:
//   float w = readWeightG();
//   if (!isnan(w)) doc["weightG"] = w;
```

Notes: use a load cell rated for at least 2x the full bin weight, mount it so lid slams do not shock it, and take the tare with the empty bin. Then set `REQUIRE_WEIGHT=1` and `MIN_WEIGHT_REMOVED_G` in `.env` to match your demo bin (default 300 g).
