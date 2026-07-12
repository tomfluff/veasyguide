// Ported from VeasyGuide. Fixes vs original: stray `7;` statement before the export
// removed; pointer-scale slider label rounded (showed float noise like 30.000000004%).
import {
  Center,
  Grid,
  Slider,
  Text,
  Title,
  ColorPicker,
  Space,
  AlphaSlider,
  Tabs,
  Divider,
  Group,
  Button,
  NativeSelect,
} from "@mantine/core";
import {
  useHighlightSettingsStore,
  setHighlightSettings,
  animationStyleOptions,
  pointerStyleOptions,
  shapeStyleOptions,
  filterStyleOptions,
  type TPointerStyle,
  type TAnimationStyle,
  type TShapeStyle,
  type TFilterStyle,
} from "../stores/HighlightSettingsStore";
import { convertToTitleCase } from "../utils/misc";

const COLOR_SWATCHES = [
  "#FF0000",
  "#FFA500",
  "#FFFF00",
  "#008000",
  "#0000FF",
  "#4B0082",
  "#EE82EE",
];

const HighlightIndicatorSettings = () => {
  const settingsStore = useHighlightSettingsStore();

  return (
    <Tabs
      className="highlight-settings"
      orientation="horizontal"
      defaultValue="appearance"
      inverted
    >
      <Tabs.Panel value="appearance">
        <Grid align="center" gutter="xs">
          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Fill</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Color</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Center>
              <ColorPicker
                fullWidth
                size="sm"
                format="hex"
                value={settingsStore.fill_color}
                onChange={(value) => setHighlightSettings({ fill_color: value })}
                withPicker={false}
                swatches={COLOR_SWATCHES}
              />
            </Center>
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Opacity</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Group gap={0}>
              <AlphaSlider
                flex={1}
                color={settingsStore.fill_color}
                value={settingsStore.fill_opacity}
                onChange={(value) => setHighlightSettings({ fill_opacity: value })}
              />
              <Center w={48}>
                <Text size="sm">{Math.round(settingsStore.fill_opacity * 100)}%</Text>
              </Center>
            </Group>
          </Grid.Col>
          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Border</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Color</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Center>
              <ColorPicker
                fullWidth
                size="sm"
                format="hex"
                value={settingsStore.border_color}
                onChange={(value) => setHighlightSettings({ border_color: value })}
                withPicker={false}
                swatches={COLOR_SWATCHES}
              />
            </Center>
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Width</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Slider
              label={`${settingsStore.border_width}px`}
              min={0}
              max={10}
              step={1}
              marks={[
                { value: 0, label: "None" },
                { value: 2, label: "2px" },
                { value: 5, label: "5px" },
                { value: 10, label: "10px" },
              ]}
              value={settingsStore.border_width}
              onChange={(value) => setHighlightSettings({ border_width: value })}
            />
            <Space h="lg" />
          </Grid.Col>
        </Grid>
      </Tabs.Panel>
      <Tabs.Panel value="behavior">
        <Grid align="center" gutter="md">
          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Shape</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Style</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <NativeSelect
              data={shapeStyleOptions.map((option) => ({
                value: option,
                label: convertToTitleCase(option),
              }))}
              value={settingsStore.shape_style}
              onChange={(event) =>
                setHighlightSettings({
                  shape_style: event.currentTarget.value as TShapeStyle,
                })
              }
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Scale</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Slider
              label={`${Math.round(settingsStore.base_scale * 100)}%`}
              marks={[
                { value: 0, label: "None" },
                { value: 1, label: "100%" },
                { value: 2, label: "200%" },
              ]}
              min={0}
              max={2}
              step={0.1}
              value={settingsStore.base_scale}
              onChange={(value) => setHighlightSettings({ base_scale: value })}
            />
            <Space h="lg" />
          </Grid.Col>

          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Animation</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Animation style</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <NativeSelect
              data={animationStyleOptions.map((option) => ({
                value: option,
                label: convertToTitleCase(option),
              }))}
              value={settingsStore.animation_style}
              onChange={(event) =>
                setHighlightSettings({
                  animation_style: event.currentTarget.value as TAnimationStyle,
                })
              }
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Animation</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Slider
              label={`${settingsStore.animation_speed}x`}
              min={0.1}
              max={2}
              step={0.1}
              marks={[
                { value: 0.1, label: "0.1x" },
                { value: 0.5, label: "0.5x" },
                { value: 1, label: "1x" },
                { value: 2, label: "2x" },
              ]}
              value={settingsStore.animation_speed}
              onChange={(value) => setHighlightSettings({ animation_speed: value })}
            />
            <Space h="lg" />
          </Grid.Col>
        </Grid>
      </Tabs.Panel>
      <Tabs.Panel value="enhance">
        <Grid align="center" gutter="md">
          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Pointer</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Shape</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <NativeSelect
              data={pointerStyleOptions.map((option) => ({
                value: option,
                label: convertToTitleCase(option),
              }))}
              value={settingsStore.pointer_style}
              onChange={(event) =>
                setHighlightSettings({
                  pointer_style: event.currentTarget.value as TPointerStyle,
                })
              }
            />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Scale</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Slider
              label={`${Math.round(settingsStore.pointer_scale * 100)}%`}
              min={0}
              max={3}
              step={0.1}
              marks={[
                { value: 0, label: "None" },
                { value: 0.5, label: "50%" },
                { value: 1, label: "100%" },
                { value: 2, label: "200%" },
                { value: 3, label: "300%" },
              ]}
              value={settingsStore.pointer_scale}
              onChange={(value) => setHighlightSettings({ pointer_scale: value })}
            />
            <Space h="lg" />
          </Grid.Col>
          <Grid.Col span={12}>
            <Divider size="lg" label={<Title order={5}>Post Processing</Title>} />
          </Grid.Col>
          <Grid.Col span={4}>
            <Title order={6}>Filter</Title>
          </Grid.Col>
          <Grid.Col span={8}>
            <Group gap="xs">
              {filterStyleOptions.map((option) => (
                <Button
                  key={option}
                  variant="filled"
                  size="xs"
                  px={6}
                  py={0}
                  color={
                    settingsStore.filter_style.includes(option as TFilterStyle)
                      ? "blue"
                      : "gray"
                  }
                  onClick={() =>
                    setHighlightSettings({
                      filter_style: settingsStore.filter_style.includes(
                        option as TFilterStyle
                      )
                        ? settingsStore.filter_style.filter((f) => f !== option)
                        : [...settingsStore.filter_style, option as TFilterStyle].sort(
                            (a, b) =>
                              filterStyleOptions.indexOf(a) -
                              filterStyleOptions.indexOf(b)
                          ),
                    })
                  }
                >
                  {convertToTitleCase(option)}
                </Button>
              ))}
            </Group>
          </Grid.Col>
        </Grid>
      </Tabs.Panel>
      <Space h="md" />
      <Tabs.List grow mb={0}>
        <Tabs.Tab value="appearance">Appearance</Tabs.Tab>
        <Tabs.Tab value="behavior">Behavior</Tabs.Tab>
        <Tabs.Tab value="enhance">Enhance</Tabs.Tab>
      </Tabs.List>
    </Tabs>
  );
};

export default HighlightIndicatorSettings;
