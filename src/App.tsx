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

interface SegmentAnalysis {
  segmentIndex: number;
  length: number;
  heading: number;
  isEastWest: boolean;
  isNorthSouth: boolean;
  samplePoints: number;
  shadowHits: number;
  sideShadeFactor: number;
  exposureScore: number;
}

interface RouteAnalysis {
  routeId: string;
  label: string;
  totalDistance: number;
  totalDuration: number;
  sunExposure: number;
  segments: SegmentAnalysis[];
  buildingsPassed: Building[];
  shadowCoverage: number;
  effectiveShadeCoverage: number;
  buildingShadowCoverage: number;
  sideShadeScore: number;
  alternativesConsidered: number;
  chosenReason: string;
}

const ROUTING_URL = 'https://router.project-osrm.org/route/v1/foot';

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

// Fetch a single route from OSRM
async function fetchRoute(start: Point, end: Point, waypoints: Point[] = []): Promise<RouteData | null> {
  try {
    const allPoints = [start, ...waypoints, end];
    const coordsStr = allPoints.map((p) => `${p.lng},${p.lat}`).join(';');
    
    const url = `${ROUTING_URL}/${coordsStr}?overview=full&geometries=geojson&steps=false`;
    console.log('Fetching route:', url);

    const res = await fetch(url);
    const data = await res.json();
    console.log('OSRM response:', data);

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      console.error('No route found in response:', data);
      return null;
    }

    const route = data.routes[0];
    const coordinates = route.geometry.coordinates;

    return {
      id: 'route',
      label: 'Route',
      color: '#aa3bff',
      coordinates,
      info: {
        distance: route.distance,
        duration: route.duration,
        sunExposure: 0,
      },
    };
  } catch (err) {
    console.error('Route fetch error:', err);
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
        
        let height = 0;
        if (e.tags.height) {
          const match = e.tags.height.match(/^(\d+(?:\.\d+)?)/);
          if (match) height = parseFloat(match[1]);
        } else if (e.tags['building:levels']) {
          height = parseFloat(e.tags['building:levels']) * 3.5;
        } else {
          height = 10;
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

// Calculate sun position
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
  if (sunElevation <= 0) return null;
  
  const shadowLength = building.height / Math.tan(sunElevation * Math.PI / 180);
  if (shadowLength < 0.1) return null;
  
  const shadowAngle = (sunAzimuth + 180) % 360;
  const shadowRad = shadowAngle * Math.PI / 180;
  
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos(building.footprint[0][1] * Math.PI / 180));
  
  const dx = Math.sin(shadowRad) * shadowLength;
  const dy = Math.cos(shadowRad) * shadowLength;
  
  const shadowPoints: [number, number][] = [];
  
  building.footprint.forEach(p => shadowPoints.push([p[0], p[1]]));
  
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

// Check if a point is inside a polygon
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

// Calculate detailed segment analysis
function analyzeSegment(
  p1: [number, number],
  p2: [number, number],
  shadows: ShadowPolygon[],
  sunAzimuth: number,
  buildings: Building[]
): SegmentAnalysis {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos(((p1[1] + p2[1]) / 2) * Math.PI / 180));
  const length = Math.sqrt(Math.pow(dx / lngDegPerKm, 2) + Math.pow(dy / latDegPerKm, 2));
  
  const heading = Math.atan2(dy, dx) * 180 / Math.PI;
  const isEastWest = Math.abs(Math.sin(heading * Math.PI / 180)) > 0.7;
  const isNorthSouth = Math.abs(Math.cos(heading * Math.PI / 180)) > 0.7;
  
  // Side shade factor
  let sideShadeFactor = 0;
  const sunFromNorth = sunAzimuth < 45 || sunAzimuth > 315;
  const sunFromSouth = sunAzimuth > 135 && sunAzimuth < 225;
  const sunFromEast = sunAzimuth > 45 && sunAzimuth < 135;
  const sunFromWest = sunAzimuth > 225 && sunAzimuth < 315;
  
  if (isEastWest && (sunFromNorth || sunFromSouth)) {
    sideShadeFactor = 0.5;
  } else if (isNorthSouth && (sunFromEast || sunFromWest)) {
    sideShadeFactor = 0.5;
  }
  
  // Sample points
  const samples = 5;
  let shadowHits = 0;
  let sideShadeHits = 0;
  
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
        shadowHits++;
        break;
      }
    }
    
    if (!inShadow && sideShadeFactor > 0) {
      sideShadeHits++;
    }
  }
  
  // Calculate exposure properly: 
  // Points in building shadow = 0 exposure
  // Points on shaded side of street = 0.5 exposure
  // Points on sunny side = 1.0 exposure
  const totalPoints = samples + 1;
  const exposedFromShadow = totalPoints - shadowHits; // Points not in shadow
  const sideShadeReduction = sideShadeHits * sideShadeFactor; // 0.5 * count
  const totalExposed = exposedFromShadow - sideShadeReduction;
  const exposureScore = totalExposed / totalPoints;
  
  return {
    segmentIndex: 0,
    length,
    heading,
    isEastWest,
    isNorthSouth,
    samplePoints: totalPoints,
    shadowHits,
    sideShadeFactor,
    exposureScore: Math.max(0, exposureScore), // Clamp to 0
  };
}

// Calculate detailed route analysis
function analyzeRoute(
  route: RouteData,
  shadows: ShadowPolygon[],
  sunAzimuth: number,
  buildings: Building[]
): RouteAnalysis {
  const segments: SegmentAnalysis[] = [];
  const buildingsPassed = new Set<number>();
  let totalShadowHits = 0;
  let totalSamples = 0;
  let sideShadeScore = 0;
  
  for (let i = 1; i < route.coordinates.length; i++) {
    const p1 = route.coordinates[i - 1];
    const p2 = route.coordinates[i];
    
    const segment = analyzeSegment(p1, p2, shadows, sunAzimuth, buildings);
    segment.segmentIndex = i - 1;
    segments.push(segment);
    
    totalShadowHits += segment.shadowHits;
    totalSamples += segment.samplePoints;
    sideShadeScore += segment.sideShadeFactor * segment.length;
    
    // Check which buildings this segment passes near
    for (const building of buildings) {
      const centerLng = building.footprint.reduce((sum, p) => sum + p[0], 0) / building.footprint.length;
      const centerLat = building.footprint.reduce((sum, p) => sum + p[1], 0) / building.footprint.length;
      
      const dist = Math.sqrt(
        Math.pow((p1[0] - centerLng) / lngDegPerKm(centerLat), 2) +
        Math.pow((p1[1] - centerLat) / latDegPerKm, 2)
      );
      
      if (dist < 0.1) { // Within 100m
        buildingsPassed.add(building.id);
      }
    }
  }
  
  // Calculate effective shade coverage: points in building shadow + points on shaded side
  const totalShadeHits = segments.reduce((sum, s) => {
    return sum + s.shadowHits + (s.samplePoints - s.shadowHits) * s.sideShadeFactor;
  }, 0);
  const effectiveShadeCoverage = totalSamples > 0 ? totalShadeHits / totalSamples : 0;
  const buildingShadowCoverage = totalSamples > 0 ? totalShadowHits / totalSamples : 0;
  const uniqueBuildings = buildings.filter(b => buildingsPassed.has(b.id));
  
  return {
    routeId: route.id,
    label: route.label,
    totalDistance: route.info.distance,
    totalDuration: route.info.duration,
    sunExposure: route.info.sunExposure,
    segments,
    buildingsPassed: uniqueBuildings,
    shadowCoverage: effectiveShadeCoverage,
    effectiveShadeCoverage,
    buildingShadowCoverage,
    sideShadeScore,
    alternativesConsidered: 0,
    chosenReason: '',
  };
}

function latDegPerKm() { return 1 / 111; }
function lngDegPerKm(lat: number) { return 1 / (111 * Math.cos(lat * Math.PI / 180)); }

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

// Calculate sun exposure for a route segment
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
    
    // Check if street is roughly E-W or N-S
    const isEastWest = Math.abs(Math.sin(segmentHeading * Math.PI / 180)) > 0.7;
    const isNorthSouth = Math.abs(Math.cos(segmentHeading * Math.PI / 180)) > 0.7;
    
    // Determine which side is shaded based on sun direction
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
      // Reduce exposure by sideShadeFactor
      exposedCount += (1 - sideShadeFactor);
    } else if (!inShadow) {
      exposedCount++;
    }
  }
  
  return exposedCount / (samples + 1);
}

// Convert building height to heatmap color
function heightToColor(height: number): string {
  const minHeight = 5;
  const maxHeight = 100;
  const normalized = Math.min(1, Math.max(0, (height - minHeight) / (maxHeight - minHeight)));
  
  const r = Math.round(255 * normalized);
  const g = Math.round(50 * (1 - normalized));
  const b = Math.round(50 * (1 - normalized));
  
  return `rgba(${r}, ${g}, ${b}, ${0.3 + 0.4 * normalized})`;
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const routeLayersRef = useRef<string[]>([]);
  const shadowLayersRef = useRef<string[]>([]);
  const heatmapLayersRef = useRef<string[]>([]);
  const heatmapIdCounter = useRef(0);
  const handleMapClickRef = useRef<(lng: number, lat: number) => void>(() => {});

  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const [routes, setRoutes] = useState<RouteData[]>([]);
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysis[]>([]);
  const [selectedTime, setSelectedTime] = useState('12:00');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('Click anywhere on the map to place start');
  const [showShadows, setShowShadows] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [sunDirection, setSunDirection] = useState<number | null>(null);
  const [showAnalysis, setShowAnalysis] = useState(false);

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
      setRouteAnalysis([]);
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
      setRouteAnalysis([]);
      clearRoutes();
      clearShadows();

      try {
        const baseline = await fetchRoute(start, end);
        if (!baseline) {
          throw new Error('No route found');
        }

        const centerLat = (start.lat + end.lat) / 2;
        const centerLon = (start.lng + end.lng) / 2;
        const sunPos = getSunPosition(centerLat, centerLon, selectedTime);
        setSunDirection(sunPos.azimuth);

        const padding = 0.005;
        const minLat = Math.min(start.lat, end.lat) - padding;
        const maxLat = Math.max(start.lat, end.lat) + padding;
        const minLon = Math.min(start.lng, end.lng) - padding;
        const maxLon = Math.max(start.lng, end.lng) + padding;
        
        const buildingsData = await fetchBuildings(minLat, minLon, maxLat, maxLon);
        setBuildings(buildingsData);

        const shadows: ShadowPolygon[] = [];
        buildingsData.forEach((building) => {
          const shadow = projectBuildingShadow(building, sunPos.azimuth, sunPos.elevation);
          if (shadow) shadows.push(shadow);
        });

        const baselineExposure = calculateRouteExposure(baseline.coordinates, shadows, sunPos.azimuth);
        baseline.info.sunExposure = baselineExposure;

        const shadowDirection = (sunPos.azimuth + 180) % 360;
        const shadowRad = shadowDirection * Math.PI / 180;
        
        const routeDx = end.lng - start.lng;
        const routeDy = end.lat - start.lat;
        const routeAngle = Math.atan2(routeDy, routeDx);
        
        const alternatives: RouteData[] = [];
        const latDegPerKm = 1 / 111;
        const lngDegPerKm = 1 / (111 * Math.cos(centerLat * Math.PI / 180));
        
        const perpendicularToSun = shadowRad + Math.PI / 2;
        
        const numSegments = 5;
        const sideOffsets = [0.15, 0.25, 0.35, 0.5];
        
        for (const sideOffset of sideOffsets) {
          for (let i = 1; i < numSegments; i++) {
            const t = i / numSegments;
            const baseLng = start.lng + (end.lng - start.lng) * t;
            const baseLat = start.lat + (end.lat - start.lat) * t;
            
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
        
        let shadiestRoute = baseline;
        let minExposure = baselineExposure;
        
        alternatives.forEach((alt) => {
          if (alt.info.sunExposure < minExposure) {
            minExposure = alt.info.sunExposure;
            shadiestRoute = alt;
          }
        });

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

        // Generate detailed analysis
        const baselineAnalysis = analyzeRoute(baseline, shadows, sunPos.azimuth, buildingsData);
        baselineAnalysis.alternativesConsidered = alternatives.length + 1;
        baselineAnalysis.chosenReason = 'Shortest path';
        
        const shadiestAnalysis = analyzeRoute(shadiestRoute, shadows, sunPos.azimuth, buildingsData);
        shadiestAnalysis.alternativesConsidered = alternatives.length + 1;
        shadiestAnalysis.chosenReason = minExposure < baselineExposure 
          ? `Lower sun exposure (${(minExposure * 100).toFixed(1)}% vs ${(baselineExposure * 100).toFixed(1)}%)`
          : 'Same as baseline (no better alternative found)';
        
        setRouteAnalysis([baselineAnalysis, shadiestAnalysis]);

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

          if (showShadows && shadows.length > 0) {
            const significantShadows = shadows.filter((s) => {
              const footprint = s.footprint;
              const building = buildingsData.find((b) => b.footprint === footprint);
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
    setRouteAnalysis([]);
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
          <label className="shadow-toggle">
            <input
              type="checkbox"
              checked={showAnalysis}
              onChange={(e) => setShowAnalysis(e.target.checked)}
              disabled={loading}
            />
            Show Analysis
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

      <div className="main-content">
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

        {showAnalysis && routeAnalysis.length > 0 && (
          <div className="analysis-panel">
            <div className="analysis-title">Route Analysis</div>
            {routeAnalysis.map((analysis) => (
              <div key={analysis.routeId} className="analysis-section">
                <div className="analysis-route-header" style={{ color: analysis.routeId === 'fastest' ? '#aa3bff' : '#22c55e' }}>
                  {analysis.label}
                </div>
                
                <div className="analysis-stats">
                  <div className="analysis-stat">
                    <span className="analysis-label">Distance:</span>
                    <span className="analysis-value">{(analysis.totalDistance / 1000).toFixed(2)} km</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Duration:</span>
                    <span className="analysis-value">{Math.round(analysis.totalDuration / 60)} min</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Sun Exposure:</span>
                    <span className="analysis-value">{(analysis.sunExposure * 100).toFixed(1)}%</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Buildings Passed:</span>
                    <span className="analysis-value">{analysis.buildingsPassed.length}</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Total Shade:</span>
                    <span className="analysis-value">{(analysis.effectiveShadeCoverage * 100).toFixed(1)}%</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Building Shade:</span>
                    <span className="analysis-value">{(analysis.buildingShadowCoverage * 100).toFixed(1)}%</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Side Shade:</span>
                    <span className="analysis-value">{((analysis.effectiveShadeCoverage - analysis.buildingShadowCoverage) * 100).toFixed(1)}%</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Side Shade Score:</span>
                    <span className="analysis-value">{analysis.sideShadeScore.toFixed(1)}</span>
                  </div>
                  <div className="analysis-stat">
                    <span className="analysis-label">Alternatives:</span>
                    <span className="analysis-value">{analysis.alternativesConsidered}</span>
                  </div>
                </div>
                
                <div className="analysis-reason">
                  <span className="analysis-label">Why chosen:</span>
                  <span className="analysis-value">{analysis.chosenReason}</span>
                </div>
                
                <div className="analysis-divider" />
                
                <div className="analysis-segments-title">Segment Breakdown</div>
                <div className="analysis-segments">
                  {analysis.segments.slice(0, 5).map((segment) => (
                    <div key={segment.segmentIndex} className="analysis-segment">
                      <div className="segment-header">
                        <span>Seg {segment.segmentIndex + 1}</span>
                        <span>{segment.length.toFixed(0)}m</span>
                      </div>
                       <div className="segment-details">
                        <span>{segment.isEastWest ? 'E-W' : segment.isNorthSouth ? 'N-S' : 'Diag'}</span>
                        <span className={segment.exposureScore < 0.5 ? 'segment-good' : 'segment-bad'}>
                          {(segment.exposureScore * 100).toFixed(0)}% sun
                        </span>
                      </div>
                      <div className="segment-shade-details">
                        <span className="segment-shade-item">
                          Bldg: {segment.shadowHits}/{segment.samplePoints}
                        </span>
                        <span className="segment-shade-item">
                          Side: {segment.sideShadeFactor > 0 ? 'Yes' : 'No'}
                        </span>
                        <span className="segment-shade-item">
                          Shade: {((1 - segment.exposureScore) * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="segment-bar">
                        <div 
                          className="segment-fill" 
                          style={{ 
                            width: `${segment.exposureScore * 100}%`,
                            backgroundColor: segment.exposureScore < 0.5 ? '#22c55e' : '#ef4444'
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  {analysis.segments.length > 5 && (
                    <div className="analysis-more">
                      ...and {analysis.segments.length - 5} more segments
                    </div>
                  )}
                </div>
                
                <div className="analysis-divider" />
                
                <div className="analysis-buildings-title">Buildings Passed</div>
                <div className="analysis-buildings">
                  {analysis.buildingsPassed.slice(0, 5).map((building) => (
                    <div key={building.id} className="analysis-building">
                      <span className="building-id">Bldg {building.id}</span>
                      <span className="building-height">{building.height.toFixed(1)}m</span>
                      <span className="building-levels">{building.levels} floors</span>
                    </div>
                  ))}
                  {analysis.buildingsPassed.length > 5 && (
                    <div className="analysis-more">
                      ...and {analysis.buildingsPassed.length - 5} more buildings
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
