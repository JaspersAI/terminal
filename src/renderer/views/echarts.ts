import * as echarts from 'echarts/core'
import { BarChart, CandlestickChart, HeatmapChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import { SVGRenderer } from 'echarts/renderers'

// ECharts, with only the parts the chart view draws with. Registered once, here, rather than in the
// component, so the list of what the app can chart is one thing to read and to add to.
//
// SVG rather than canvas: a workspace is many small charts rather than one big one, which is the
// case SVG is lighter for, and it stays crisp on any display and in a screenshot.

echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  PieChart,
  CandlestickChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  VisualMapComponent,
  MarkLineComponent,
  LabelLayout,
  SVGRenderer,
])

export { echarts }
export type EChart = echarts.ECharts
export type EChartsOption = echarts.EChartsCoreOption
