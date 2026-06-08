import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';
import * as SunCalc from 'suncalc';

interface Point {
  lng: number;
  lat: number;
}

interface RouteInfo {
  distance: number;
  duration: number;
  sunExposure: number;
}

interface RouteData {
  id: string;
  label: string;
  color: string;
  coordinates: [number, number][];
  info: RouteInfo;
}

interface Building {
  id: number;
  footprint: [number, number][];
  height: number;
  levels: number;
}

interface ShadowPolygon {
  footprint: [number, number][];
  shadow: [number, number][];
}

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';

const TIME_OPTIONS = [
  { label: 'Now', value: 'now' },
  { label: '9 AM', value: '09:00' },
  { label: '12 PM', value: '12:00' },
  { label: '3 PM', value: '15:00' },
  { label: '6 PM', value: '18:00' },
];

// Custom polyline decoder (Valhalla uses 6-digit precision)
function decodePolyline(str: string, precision = 6): [number, number][] {
  const coordinates: [number, number][] = [];
  const factor = Math.pow(10, precision);
  let i = 0;
  let lat = 0;
  let lng = 0;

  while (i < str.length) {
    let byte = 0;
    let shift = 0;
    let result = 0;

    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += deltaLat;

    shift = 0;
    result = 0;

    do {
      byte = str.charCodeAt(i++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    const deltaLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += deltaLng;

    coordinates.push([lng / factor, lat / factor]);
  }

  return coordinates;
}

// Fetch a single route from Valhalla
async function fetchRoute(start: Point, end: Point, waypoints: Point[] = []): Promise<RouteData | null> {
  try {
    const locations = [
      { lon: start.lng, lat: start.lat },
      ...waypoints.map((wp) => ({ lon: wp.lng, lat: wp.lat })),
      { lon: end.lng, lat: end.lat },
    ];

    const res = await fetch(VALHALLA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        locations,
        costing: 'pedestrian',
      }),
    });

    const data = await res.json();

    if (!data.trip || !data.trip.legs || data.trip.legs.length === 0) {
      return null;
    }

    // Concatenate all legs
    const coordinates: [number, number][] = [];
    data.trip.legs.forEach((leg: any) => {
      const legCoords = decodePolyline(leg.shape, 6);
      if (coordinates.length === 0) {
        coordinates.push(...legCoords);
      } else {
        coordinates.push(...legCoords.slice(1));
      }
    });

    const summary = data.trip.summary;

    return {
      id: 'route',
      label: 'Route',
      color: '#aa3bff',
      coordinates,
      info: {
        distance: summary.length * 1000,
        duration: summary.time,
        sunExposure: 0,
      },
    };
  } catch {
    return null;
  }
}

// Fetch building data from Overpass API
async function fetchBuildings(minLat: number, minLon: number, maxLat: number, maxLon: number): Promise<Building[]> {
  try {
    const query = `[out:json][timeout:25];
      way["building"](${minLat},${minLon},${maxLat},${maxLon});
      out geom;`;

    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    const data = await res.json();
    const buildings: Building[] = data.elements
      .filter((e: any) => e.type === 'way')
      .map((e: any) => {
        const footprint = e.geometry.map((n: any) => [n.lon, n.lat] as [number, number]);
        
        // Get height: explicit height > levels estimate > default
        let height = 0;
        if (e.tags.height) {
          const match = e.tags.height.match(/^(\d+(?:\.\d+)?)/);
          if (match) height = parseFloat(match[1]);
        } else if (e.tags['building:levels']) {
          height = parseFloat(e.tags['building:levels']) * 3.5;
        } else {
          height = 10; // Default 10m
        }

        return {
          id: e.id,
          footprint,
          height,
          levels: parseFloat(e.tags['building:levels']) || 1,
        };
      })
      .filter((b: Building) => b.height > 0);

    return buildings;
  } catch {
    return [];
  }
}

// Calculate sun position for a given time
function getSunPosition(lat: number, lon: number, timeStr: string) {
  let date: Date;
  
  if (timeStr === 'now') {
    date = new Date();
  } else {
    const [hours, minutes] = timeStr.split(':').map(Number);
    date = new Date();
    date.setHours(hours, minutes, 0, 0);
  }
  
  const pos = SunCalc.getPosition(date, lat, lon);
  return {
    azimuth: (pos.azimuth * 180 / Math.PI + 360) % 360,
    elevation: pos.altitude * 180 / Math.PI,
  };
}

// Project shadow for a building
function projectBuildingShadow(building: Building, sunAzimuth: number, sunElevation: number): ShadowPolygon | null {
  if (sunElevation <= 0) return null; // No shadow when sun is below horizon
  
  const shadowLength = building.height / Math.tan(sunElevation * Math.PI / 180);
  if (shadowLength < 0.1) return null;
  
  // Shadow direction (opposite of sun)
  const shadowAngle = (sunAzimuth + 180) % 360;
  const shadowRad = shadowAngle * Math.PI / 180;
  
  // Approximate degrees per km
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos(building.footprint[0][1] * Math.PI / 180));
  
  const dx = Math.sin(shadowRad) * shadowLength;
  const dy = Math.cos(shadowRad) * shadowLength;
  
  const shadowPoints: [number, number][] = [];
  
  // Add footprint points
  building.footprint.forEach(p => shadowPoints.push([p[0], p[1]]));
  
  // Add shadow points (offset by footprint)
  for (let i = building.footprint.length - 1; i >= 0; i--) {
    const p = building.footprint[i];
    shadowPoints.push([
      p[0] + dx * lngDegPerKm,
      p[1] + dy * latDegPerKm,
    ]);
  }
  
  return {
    footprint: building.footprint,
    shadow: shadowPoints,
  };
}

// Check if a point is inside a polygon (ray casting)
function pointInPolygon(point: [number, number], polygon: [number, number][]) {
  const x = point[0], y = point[1];
  let inside = false;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  
  return inside;
}

// Check if a line segment intersects with a polygon
function segmentIntersectsPolygon(p1: [number, number], p2: [number, number], polygon: [number, number][]) {
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    if (segmentsIntersect(p1, p2, polygon[i], polygon[j])) {
      return true;
    }
  }
  return false;
}

// Check if two line segments intersect
function segmentsIntersect(
  a1: [number, number], a2: [number, number],
  b1: [number, number], b2: [number, number]
) {
  const ccw = (A: [number, number], B: [number, number], C: [number, number]) => {
    return (C[0] - A[0]) * (B[1] - A[1]) > (B[0] - A[0]) * (C[1] - A[1]);
  };
  
  return ccw(a1, b1, b2) !== ccw(a2, b1, b2) && ccw(a1, a2, b1) !== ccw(a1, a2, b2);
}

// Calculate sun exposure for a route segment
// KEY: Also check side-of-street shade
function calculateSegmentExposure(
  p1: [number, number],
  p2: [number, number],
  shadows: ShadowPolygon[],
  sunAzimuth?: number
): number {
  // Sample points along the segment
  const samples = 5;
  let exposedCount = 0;
  
  // Calculate side-of-street shade if sun azimuth is provided
  let sideShadeFactor = 0;
  if (sunAzimuth !== undefined) {
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const segmentHeading = Math.atan2(dy, dx) * 180 / Math.PI;
    
    // For a street, one side is shaded, the other is sunny
    // The shaded side depends on street orientation and sun direction
    // If street is E-W (heading ~90 or 270), and sun is from north (azimuth ~0), south side is shaded
    // If street is N-S (heading ~0 or 180), and sun is from east (azimuth ~90), west side is shaded
    
    // Check if street is roughly E-W or N-S
    const isEastWest = Math.abs(Math.sin(segmentHeading * Math.PI / 180)) > 0.7;
    const isNorthSouth = Math.abs(Math.cos(segmentHeading * Math.PI / 180)) > 0.7;
    
    // Determine which side is shaded based on sun direction
    // North sun (azimuth ~0-45 or ~315-360): south side of E-W streets is shaded
    // South sun (azimuth ~135-225): north side of E-W streets is shaded
    // East sun (azimuth ~45-135): west side of N-S streets is shaded
    // West sun (azimuth ~225-315): east side of N-S streets is shaded
    
    const sunFromNorth = sunAzimuth < 45 || sunAzimuth > 315;
    const sunFromSouth = sunAzimuth > 135 && sunAzimuth < 225;
    const sunFromEast = sunAzimuth > 45 && sunAzimuth < 135;
    const sunFromWest = sunAzimuth > 225 && sunAzimuth < 315;
    
    if (isEastWest && (sunFromNorth || sunFromSouth)) {
      sideShadeFactor = 0.5; // One side is shaded
    } else if (isNorthSouth && (sunFromEast || sunFromWest)) {
      sideShadeFactor = 0.5; // One side is shaded
    }
  }
  
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const point: [number, number] = [
      p1[0] + (p2[0] - p1[0]) * t,
      p1[1] + (p2[1] - p1[1]) * t,
    ];
    
    let inShadow = false;
    for (const shadow of shadows) {
      if (pointInPolygon(point, shadow.shadow)) {
        inShadow = true;
        break;
      }
    }
    
    // If not in building shadow, check if on shaded side of street
    if (!inShadow && sideShadeFactor > 0) {
      // Randomly assign shade (in reality, we'd know which side we're on)
      // For now, we reduce exposure by the sideShadeFactor
      exposedCount += (1 - sideShadeFactor);
    } else if (!inShadow) {
      exposedCount++;
    }
  }
  
  return exposedCount / (samples + 1);
}

// Convert building height to heatmap color (red = taller)
function heightToColor(height: number): string {
  const minHeight = 5;
  const maxHeight = 100;
  const normalized = Math.min(1, Math.max(0, (height - minHeight) / (maxHeight - minHeight)));
  
  // Red intensity based on height
  const r = Math.round(255 * normalized);
  const g = Math.round(50 * (1 - normalized));
  const b = Math.round(50 * (1 - normalized));
  
  return `rgba(${r}, ${g}, ${b}, ${0.3 + 0.4 * normalized})`;
}

// Calculate total sun exposure for a route
function calculateRouteExposure(
  coordinates: [number, number][],
  shadows: ShadowPolygon[],
  sunAzimuth?: number
): number {
  let totalExposure = 0;
  let totalLength = 0;
  
  for (let i = 1; i < coordinates.length; i++) {
    const p1 = coordinates[i - 1];
    const p2 = coordinates[i];
    
    // Calculate segment length
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const latDegPerKm = 1 / 111;
    const lngDegPerKm = 1 / (111 * Math.cos(((p1[1] + p2[1]) / 2) * Math.PI / 180));
    const length = Math.sqrt(Math.pow(dx / lngDegPerKm, 2) + Math.pow(dy / latDegPerKm, 2));
    
    const exposure = calculateSegmentExposure(p1, p2, shadows, sunAzimuth);
    totalExposure += exposure * length;
    totalLength += length;
  }
  
  return totalLength > 0 ? totalExposure / totalLength : 0;
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const routeLayersRef = useRef<string[]>([]);
  const shadowLayersRef = useRef<string[]>([]);
  const handleMapClickRef = useRef<(lng: number, lat: number) => void>(() => {});

  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const [routes, setRoutes] = useState<RouteData[]>([]);
  const [selectedTime, setSelectedTime] = useState('12:00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('Click anywhere on the map to place start');
  const [showShadows, setShowShadows] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [sunDirection, setSunDirection] = useState<number | null>(null);
  const heatmapLayersRef = useRef<string[]>([]);
  const heatmapIdCounter = useRef(0);

  const clearMarkers = () => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
  };

  const clearRoutes = () => {
    const map = mapRef.current;
    if (!map) return;
    routeLayersRef.current.forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });
    routeLayersRef.current = [];
  };

  const clearShadows = () => {
    const map = mapRef.current;
    if (!map) return;
    shadowLayersRef.current.forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });
    shadowLayersRef.current = [];
  };

  const clearHeatmap = () => {
    const map = mapRef.current;
    if (!map) return;
    heatmapLayersRef.current.forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    });
    heatmapLayersRef.current = [];
  };

  const drawBuildingHeatmap = (buildingsToDraw: Building[]) => {
    const map = mapRef.current;
    if (!map || buildingsToDraw.length === 0) return;

    clearHeatmap();

    const features = buildingsToDraw.map((building) => ({
      type: 'Feature',
      properties: {
        height: building.height,
        color: heightToColor(building.height),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [building.footprint],
      },
    }));

    const sourceId = `heatmap-${heatmapIdCounter.current++}`;
    
    map.addSource(sourceId, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features,
      },
    });

    map.addLayer({
      id: sourceId,
      type: 'fill',
      source: sourceId,
      paint: {
        'fill-color': ['get', 'color'],
        'fill-opacity': 0.6,
      },
    });

    const outlineId = `${sourceId}-outline`;
    map.addLayer({
      id: outlineId,
      type: 'line',
      source: sourceId,
      paint: {
        'line-color': '#ffffff',
        'line-width': 0.5,
        'line-opacity': 0.3,
      },
    });

    heatmapLayersRef.current.push(sourceId);
    heatmapLayersRef.current.push(outlineId);
  };

  const handleMapClick = (lng: number, lat: number) => {
    if (!start) {
      setStart({ lng, lat });
      setInstruction('Click again to place destination');
    } else if (!end) {
      setEnd({ lng, lat });
      setInstruction('Route is loading...');
    } else {
      setStart({ lng, lat });
      setEnd(null);
      setRoutes([]);
      setError(null);
      clearMarkers();
      clearRoutes();
      clearShadows();
      setInstruction('Click again to place destination');
    }
  };

  handleMapClickRef.current = handleMapClick;

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors',
          },
        },
        layers: [
          {
            id: 'osm-layer',
            type: 'raster',
            source: 'osm',
          },
        ],
      },
      center: [-73.9857, 40.7484],
      zoom: 14,
    });

    map.addControl(new maplibregl.NavigationControl());

    map.on('click', (e) => {
      const { lng, lat } = e.lngLat;
      handleMapClickRef.current(lng, lat);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    clearMarkers();

    if (start) {
      const el = document.createElement('div');
      el.className = 'marker marker-start';
      const marker = new maplibregl.Marker({ element: el }).setLngLat([start.lng, start.lat]).addTo(map);
      markersRef.current.push(marker);
    }

    if (end) {
      const el = document.createElement('div');
      el.className = 'marker marker-end';
      const marker = new maplibregl.Marker({ element: el }).setLngLat([end.lng, end.lat]).addTo(map);
      markersRef.current.push(marker);
    }
  }, [start, end]);

  // Draw heatmap when buildings or showHeatmap changes
  useEffect(() => {
    if (showHeatmap && buildings.length > 0) {
      drawBuildingHeatmap(buildings);
    } else {
      clearHeatmap();
    }
    return () => {
      clearHeatmap();
    };
  }, [showHeatmap, buildings]);

  useEffect(() => {
    if (!start || !end) return;

    const fetchRoutes = async () => {
      setLoading(true);
      setError(null);
      setRoutes([]);
      clearRoutes();
      clearShadows();

      try {
        // 1. Fetch baseline route
        const baseline = await fetchRoute(start, end);
        if (!baseline) {
          throw new Error('No route found');
        }

        // 2. Calculate sun position
        const centerLat = (start.lat + end.lat) / 2;
        const centerLon = (start.lng + end.lng) / 2;
        const sunPos = getSunPosition(centerLat, centerLon, selectedTime);
        setSunDirection(sunPos.azimuth);
        
        console.log('Sun position:', sunPos);

        // 3. Fetch building data for the route area
        const padding = 0.005; // ~500m padding
        const minLat = Math.min(start.lat, end.lat) - padding;
        const maxLat = Math.max(start.lat, end.lat) + padding;
        const minLon = Math.min(start.lng, end.lng) - padding;
        const maxLon = Math.max(start.lng, end.lng) + padding;
        
        const buildings = await fetchBuildings(minLat, minLon, maxLat, maxLon);
        console.log('Buildings fetched:', buildings.length);
        setBuildings(buildings);

        // 4. Calculate shadows
        const shadows: ShadowPolygon[] = [];
        buildings.forEach((building) => {
          const shadow = projectBuildingShadow(building, sunPos.azimuth, sunPos.elevation);
          if (shadow) shadows.push(shadow);
        });
        console.log('Shadows calculated:', shadows.length);

        // 5. Calculate sun exposure for baseline
        const baselineExposure = calculateRouteExposure(baseline.coordinates, shadows, sunPos.azimuth);
        baseline.info.sunExposure = baselineExposure;

        // 6. Generate SHADE-AWARE waypoints
        // The key insight: we want waypoints on the SHADED SIDE of streets
        // Shadow direction is opposite to sun direction
        const shadowDirection = (sunPos.azimuth + 180) % 360;
        const shadowRad = shadowDirection * Math.PI / 180;
        
        // Perpendicular to route direction (to hit side streets)
        const routeDx = end.lng - start.lng;
        const routeDy = end.lat - start.lat;
        const routeLength = Math.sqrt(routeDx * routeDx + routeDy * routeDy);
        const routeAngle = Math.atan2(routeDy, routeDx);
        
        const alternatives: RouteData[] = [];
        const latDegPerKm = 1 / 111;
        const lngDegPerKm = 1 / (111 * Math.cos(centerLat * Math.PI / 180));
        
        // Generate waypoints specifically on the SHADED SIDE
        // Offset perpendicular to the sun direction (which is the shaded side)
        const perpendicularToSun = shadowRad + Math.PI / 2;
        
        // Create waypoints along the route, offset to the shaded side
        const numSegments = 5;
        const sideOffsets = [0.15, 0.25, 0.35, 0.5]; // 150m, 250m, 350m, 500m to the side
        
        for (const sideOffset of sideOffsets) {
          for (let i = 1; i < numSegments; i++) {
            const t = i / numSegments;
            const baseLng = start.lng + (end.lng - start.lng) * t;
            const baseLat = start.lat + (end.lat - start.lat) * t;
            
            // Offset to the SHADED side (perpendicular to sun)
            const waypoint = {
              lng: baseLng + Math.cos(perpendicularToSun) * sideOffset * lngDegPerKm,
              lat: baseLat + Math.sin(perpendicularToSun) * sideOffset * latDegPerKm,
            };
            
            const route = await fetchRoute(start, end, [waypoint]);
            if (route) {
              const exposure = calculateRouteExposure(route.coordinates, shadows, sunPos.azimuth);
              route.info.sunExposure = exposure;
              alternatives.push(route);
            }
            
            // Also try the opposite side (for comparison)
            const oppositeWaypoint = {
              lng: baseLng - Math.cos(perpendicularToSun) * sideOffset * lngDegPerKm,
              lat: baseLat - Math.sin(perpendicularToSun) * sideOffset * latDegPerKm,
            };
            
            const routeOpposite = await fetchRoute(start, end, [oppositeWaypoint]);
            if (routeOpposite) {
              const exposureOpp = calculateRouteExposure(routeOpposite.coordinates, shadows, sunPos.azimuth);
              routeOpposite.info.sunExposure = exposureOpp;
              alternatives.push(routeOpposite);
            }
          }
        }
        
        // Also try: route that goes THROUGH the shadow zone
        // Add a waypoint that's directly in the shadow direction from the midpoint
        const midpointShadow = {
          lng: centerLon + Math.cos(shadowRad) * 0.3 * lngDegPerKm,
          lat: centerLat + Math.sin(shadowRad) * 0.3 * latDegPerKm,
        };
        
        const routeShadow = await fetchRoute(start, end, [midpointShadow]);
        if (routeShadow) {
          const exposureShadow = calculateRouteExposure(routeShadow.coordinates, shadows, sunPos.azimuth);
          routeShadow.info.sunExposure = exposureShadow;
          alternatives.push(routeShadow);
        }
        
        console.log('Alternatives generated:', alternatives.length);
        console.log('Shadow direction:', shadowDirection);
        console.log('Sun direction:', sunPos.azimuth);

        // 7. Pick the shadiest route
        let shadiestRoute = baseline;
        let minExposure = baselineExposure;
        
        alternatives.forEach((alt) => {
          if (alt.info.sunExposure < minExposure) {
            minExposure = alt.info.sunExposure;
            shadiestRoute = alt;
          }
        });

        // 8. Create final route data
        const allRoutes: RouteData[] = [
          {
            ...baseline,
            id: 'fastest',
            label: 'Fastest Route',
            color: '#aa3bff',
          },
          {
            ...shadiestRoute,
            id: 'shadiest',
            label: `Shadiest Route (${selectedTime})`,
            color: '#22c55e',
          },
        ];

        setRoutes(allRoutes);

        // Log which route was chosen
        console.log('Baseline exposure:', baselineExposure.toFixed(3));
        console.log('Shadiest exposure:', minExposure.toFixed(3));
        console.log('Same route?', baseline.coordinates.length === shadiestRoute.coordinates.length && 
          baseline.coordinates[0][0] === shadiestRoute.coordinates[0][0]);

        // 9. Draw routes on map
        const map = mapRef.current;
        if (map) {
          const allBounds = new maplibregl.LngLatBounds();

          allRoutes.forEach((route, index) => {
            const routeId = `route-${route.id}`;
            
            map.addSource(routeId, {
              type: 'geojson',
              data: {
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: route.coordinates,
                },
              },
            });

            map.addLayer({
              id: routeId,
              type: 'line',
              source: routeId,
              layout: {
                'line-join': 'round',
                'line-cap': 'round',
              },
              paint: {
                'line-color': route.color,
                'line-width': index === 0 ? 6 : 4,
                'line-opacity': index === 0 ? 1 : 0.8,
              },
            });

            routeLayersRef.current.push(routeId);

            route.coordinates.forEach((coord: [number, number]) => {
              allBounds.extend(coord);
            });
          });

          // Draw shadow polygons if enabled (only for tall buildings, very transparent)
          if (showShadows && shadows.length > 0) {
            const significantShadows = shadows.filter((s) => {
              // Only show shadows for buildings taller than 20m
              const footprint = s.footprint;
              const building = buildings.find((b) => b.footprint === footprint);
              return building && building.height > 20;
            });

            significantShadows.forEach((shadow, index) => {
              const shadowId = `shadow-${index}`;
              map.addSource(shadowId, {
                type: 'geojson',
                data: {
                  type: 'Feature',
                  properties: {},
                  geometry: {
                    type: 'Polygon',
                    coordinates: [shadow.shadow],
                  },
                },
              });

              map.addLayer({
                id: shadowId,
                type: 'fill',
                source: shadowId,
                paint: {
                  'fill-color': '#000000',
                  'fill-opacity': 0.05,
                },
              });

              shadowLayersRef.current.push(shadowId);
            });
          }

          map.fitBounds(allBounds, { padding: 80, duration: 800 });
        }

        setInstruction('Click anywhere to start a new route');
      } catch (err) {
        console.error('Route error:', err);
        setError(err instanceof Error ? err.message : 'Failed to get routes');
        setInstruction('Click anywhere to start a new route');
      } finally {
        setLoading(false);
      }
    };

    fetchRoutes();
  }, [start, end, selectedTime, showShadows]);

  const handleReset = () => {
    setStart(null);
    setEnd(null);
    setRoutes([]);
    setBuildings([]);
    setSunDirection(null);
    setError(null);
    setInstruction('Click anywhere on the map to place start');
    clearMarkers();
    clearRoutes();
    clearShadows();
    clearHeatmap();
  };

  return (
    <div className="app">
      <div className="top-bar">
        <div className="brand">VampireMap</div>
        <div className="controls">
          <select
            className="time-select"
            value={selectedTime}
            onChange={(e) => setSelectedTime(e.target.value)}
            disabled={loading}
          >
            {TIME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <label className="shadow-toggle">
            <input
              type="checkbox"
              checked={showShadows}
              onChange={(e) => setShowShadows(e.target.checked)}
              disabled={loading}
            />
            Show Shadows
          </label>
          <label className="shadow-toggle">
            <input
              type="checkbox"
              checked={showHeatmap}
              onChange={(e) => setShowHeatmap(e.target.checked)}
              disabled={loading}
            />
            Show Heatmap
          </label>
        </div>
        <div className="status">
          {loading ? (
            <span className="loading">Loading routes...</span>
          ) : (
            <span>{instruction}</span>
          )}
        </div>
        <button className="reset-btn" onClick={handleReset} disabled={!start && !end}>
          Reset
        </button>
      </div>

      <div className="map-wrap">
        <div ref={mapContainer} className="map-container" />

        {routes.length > 0 && (
          <div className="legend-panel">
            <div className="legend-title">Route Comparison</div>
            {sunDirection !== null && (
              <div className="legend-row">
                <span className="legend-label">Sun Direction:</span>
                <span className="legend-info">{sunDirection.toFixed(0)}°</span>
              </div>
            )}
            <div className="legend-divider" />
            {routes.map((route) => (
              <div key={route.id} className="legend-item">
                <div className="legend-color" style={{ backgroundColor: route.color }} />
                <span className="legend-label">{route.label}</span>
                <span className="legend-info">
                  {Math.round(route.info.duration / 60)} min | {(route.info.distance / 1000).toFixed(2)} km
                </span>
              </div>
            ))}
            <div className="legend-divider" />
            {routes.length > 1 && (
              <div className="legend-comparison">
                <div className="legend-row">
                  <span className="legend-label">Sun Exposure:</span>
                </div>
                {routes.map((route) => (
                  <div key={route.id} className="legend-row">
                    <span className="legend-label" style={{ color: route.color }}>
                      {route.label.split(' (')[0]}
                    </span>
                    <span className="legend-info">
                      {(route.info.sunExposure * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="route-panel error">
            <div className="panel-row">
              <span className="label">Error</span>
              <span className="value">{error}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
